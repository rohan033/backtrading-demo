"""Market hunter: background scanner that scores screener candidates 0-100.

Runs continuously regardless of sessions. Consumes STORED screener results
(never triggers screener refreshes), filters against the trade-halts panel,
and emits suggestion dicts into an in-memory ring buffer plus per-session
event logs. Scoring is a Python port of the strong-buy heuristics in
frontend/src/lib/overviewSignals.ts.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.broker import fetch_five_minute_candles, fetch_quote
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.events import AgentEvent, EventTier, EventType, get_event_bus
from control_plane.agentic.halt_execution import (
    get_halt_resume_tracker,
    reconcile_sessions_for_resumed_tickers,
)
from control_plane.agentic.session_store import get_agentic_session_store
from control_plane.agentic.snapshot import SessionSnapshot

log = logging.getLogger("backtrading")

RING_BUFFER_SIZE = 100
TOP_ROWS_PER_SCREENER = 15


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "").replace("%", "").replace("$", ""))
    except (TypeError, ValueError):
        return None


def _ticker_symbol(raw: Any) -> str:
    """'NASDAQ:ABCD' -> 'ABCD' (mirrors frontend tickerSymbol)."""
    text = str(raw or "").strip()
    if ":" in text:
        text = text.split(":")[-1]
    return text.strip().upper()


def _row_change_pct(cells: dict[str, Any]) -> float | None:
    for key in ("change_pct", "change", "premarket_change", "postmarket_change"):
        value = _parse_float(cells.get(key))
        if value is not None:
            return value
    return None


def _row_price(cells: dict[str, Any]) -> float | None:
    for key in ("last_price", "close", "premarket_close", "postmarket_close", "price"):
        value = _parse_float(cells.get(key))
        if value is not None:
            return value
    return None


def _row_volume(cells: dict[str, Any]) -> float | None:
    for key in ("volume", "premarket_volume", "postmarket_volume", "total_volume"):
        value = _parse_float(cells.get(key))
        if value is not None:
            return value
    return None


class MarketHunter:
    """Continuously score screener candidates and emit suggestions."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._suggestions: deque[dict[str, Any]] = deque(maxlen=RING_BUFFER_SIZE)
        self._subscribers: list[asyncio.Queue] = []
        # ticker -> monotonic time of last emit (cooldown)
        self._last_emitted: dict[str, float] = {}
        self._scanning = False
        self._last_scan_at: str | None = None
        self._last_scan_stats: dict[str, int] = {}

    # ── Lifecycle ──

    @property
    def interval_seconds(self) -> float:
        return max(10.0, float(DEFAULT_CONFIG["hunter_interval_seconds"]))

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="agentic-market-hunter")
        log.info("[AGENTIC_HUNTER] Started (every %.0fs)", self.interval_seconds)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        log.info("[AGENTIC_HUNTER] Stopped")

    def clear_suggestion_cooldown(self, ticker: str) -> None:
        """Allow the hunter to re-emit a ticker after a position closes."""
        self._last_emitted.pop(str(ticker or "").upper(), None)

    async def nudge_watchlist_tickers(self, tickers: list[str]) -> None:
        """Clear cooldowns and run an immediate scan for freed watchlist slots."""
        cleaned = [str(ticker or "").upper() for ticker in tickers if ticker]
        for ticker in cleaned:
            self.clear_suggestion_cooldown(ticker)
        if cleaned:
            await self.scan_once()

    async def _run(self) -> None:
        while True:
            try:
                await self.scan_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.error("[AGENTIC_HUNTER] Scan failed: %s", exc, exc_info=True)
            await asyncio.sleep(self.interval_seconds)

    # ── Consumers ──

    def recent_suggestions(self, limit: int = 30) -> list[dict[str, Any]]:
        """Latest suggestions, newest first."""
        items = list(self._suggestions)
        items.reverse()
        return items[: max(1, int(limit))]

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=RING_BUFFER_SIZE)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with contextlib.suppress(ValueError):
            self._subscribers.remove(queue)

    def status(self) -> dict[str, Any]:
        """Lightweight hunter heartbeat for API / UI polling."""
        running = self._task is not None and not self._task.done()
        return {
            "running": running,
            "scanning": self._scanning,
            "last_scan_at": self._last_scan_at,
            "last_candidates_count": int(self._last_scan_stats.get("candidates", 0)),
            "last_emitted_count": int(self._last_scan_stats.get("emitted", 0)),
        }

    # ── Scan scope from running sessions ──

    @staticmethod
    def _session_watchlist(session: dict[str, Any]) -> set[str]:
        config = session.get("config") or {}
        return {
            ticker
            for ticker in (_ticker_symbol(raw) for raw in (config.get("tickers") or []))
            if ticker
        }

    @staticmethod
    def _session_screener_ids(session: dict[str, Any]) -> list[str]:
        config = session.get("config") or {}
        return [str(item) for item in (config.get("screener_ids") or []) if str(item).strip()]

    @classmethod
    def _is_watchlist_only(cls, session: dict[str, Any]) -> bool:
        """Tickers set + no screener_ids => focused session; ignore screener universe."""
        return bool(cls._session_watchlist(session)) and not cls._session_screener_ids(session)

    @classmethod
    def _scan_scope(
        cls,
        sessions: list[dict[str, Any]],
    ) -> tuple[set[str] | None, dict[str, str], set[str]]:
        """Return (screener_id filter or None=all), ticker->account_env, all manual tickers.

        Watchlist-only sessions (tickers set, empty screener_ids) do not open the
        screener universe. Discovery mode (no tickers, no screener_ids) still means
        all screeners. Explicit screener_ids are unioned across sessions.
        """
        if not sessions:
            return None, {}, set()
        wants_all_screeners = False
        has_explicit_screeners = False
        screener_union: set[str] = set()
        manual_tickers: set[str] = set()
        ticker_env: dict[str, str] = {}
        for session in sessions:
            config = session.get("config") or {}
            ids = cls._session_screener_ids(session)
            watchlist = cls._session_watchlist(session)
            for ticker in watchlist:
                manual_tickers.add(ticker)
                ticker_env[ticker] = str(session.get("account_env") or "demo")
            if ids:
                has_explicit_screeners = True
                screener_union.update(ids)
            elif not watchlist:
                # No watchlist and no screener filter => open discovery.
                wants_all_screeners = True
            # else: watchlist-only — contributes tickers, no screeners
        if wants_all_screeners:
            screener_filter: set[str] | None = None
        elif has_explicit_screeners:
            screener_filter = screener_union
        else:
            screener_filter = set()
        return screener_filter, ticker_env, manual_tickers

    # ── Scan ──

    def _halted_symbols(self) -> set[str]:
        try:
            from control_plane.trade_halts_store import get_trade_halts_store

            rows = get_trade_halts_store().list_all_halts()
        except Exception as exc:
            log.debug("[AGENTIC_HUNTER] halts lookup failed: %s", exc)
            return set()
        return {
            _ticker_symbol(row.get("symbol"))
            for row in rows
            if str(row.get("status") or "").lower() == "halted"
        }

    def _screener_candidates(
        self, screener_ids: set[str] | None = None
    ) -> dict[str, dict[str, Any]]:
        """ticker -> best row info + list of screeners it appears in."""
        from control_plane.screener_store import get_screener_store

        candidates: dict[str, dict[str, Any]] = {}
        for screener in get_screener_store().list_screeners(include_results=True):
            screener_id = str(screener.get("id") or "")
            if screener_ids is not None and screener_id not in screener_ids:
                continue
            name = str(screener.get("name") or "Screener")
            results = (screener.get("results") or [])[:TOP_ROWS_PER_SCREENER]
            for row in results:
                ticker = _ticker_symbol(row.get("ticker"))
                if not ticker:
                    continue
                cells = row.get("cells") or {}
                rank = _parse_float(row.get("rank"))
                if rank is None:
                    rank = float(row.get("position") or 0) + 1
                entry = candidates.setdefault(
                    ticker,
                    {
                        "ticker": ticker,
                        "screeners": [],
                        "screener_ids": [],
                        "change_pct": None,
                        "price": None,
                        "volume": None,
                        "best_rank": rank,
                        "source_screener": name,
                        "source_screener_id": screener_id,
                        "source": "screener",
                    },
                )
                entry["screeners"].append(name)
                if screener_id:
                    entry["screener_ids"].append(screener_id)
                change = _row_change_pct(cells)
                if change is not None and (
                    entry["change_pct"] is None or change > entry["change_pct"]
                ):
                    entry["change_pct"] = change
                    entry["source_screener"] = name
                    entry["source_screener_id"] = screener_id
                price = _row_price(cells)
                if price is not None and entry["price"] is None:
                    entry["price"] = price
                volume = _row_volume(cells)
                if volume is not None and (
                    entry["volume"] is None or volume > entry["volume"]
                ):
                    entry["volume"] = volume
                if rank < entry["best_rank"]:
                    entry["best_rank"] = rank
        return candidates

    async def _manual_ticker_candidates(
        self,
        tickers: set[str],
        ticker_env: dict[str, str],
        existing: dict[str, dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        """Fetch quote/candles for manual watchlist tickers not already in screener rows."""
        manual: dict[str, dict[str, Any]] = {}
        pending = [t for t in tickers if t not in existing]
        if not pending:
            return manual

        async def _one(ticker: str) -> tuple[str, dict[str, Any] | None]:
            env = ticker_env.get(ticker, "demo")
            quote, candles = await asyncio.gather(
                fetch_quote(env, ticker),
                fetch_five_minute_candles(env, ticker, count=12),
            )
            price = float((quote or {}).get("price") or 0.0)
            if price <= 0:
                return ticker, None
            change_pct: float | None = None
            closes = [float(c["close"]) for c in candles if c.get("close")]
            if len(closes) >= 2 and closes[0] > 0:
                change_pct = (closes[-1] - closes[0]) / closes[0] * 100.0
            return ticker, {
                "ticker": ticker,
                "screeners": [],
                "screener_ids": [],
                "change_pct": change_pct,
                "price": price,
                "volume": None,
                "best_rank": 999.0,
                "source_screener": "Manual watchlist",
                "source_screener_id": None,
                "source": "manual",
            }

        results = await asyncio.gather(*(_one(ticker) for ticker in pending))
        for ticker, candidate in results:
            if candidate is not None:
                manual[ticker] = candidate
        return manual

    @staticmethod
    def _score(candidate: dict[str, Any]) -> tuple[float, list[str]]:
        """0-100 momentum score (port of overviewSignals strong-buy scoring)."""
        change = float(candidate["change_pct"] or 0.0)
        reasons = [f"{candidate['source_screener']}: +{change:.2f}%"]
        score = 40.0 + min(25.0, change * 2.0)

        if candidate["best_rank"] <= 3:
            score += 8.0
            reasons.append("Top-3 screener rank")

        extra_screeners = len(set(candidate["screeners"])) - 1
        if extra_screeners > 0:
            bonus = min(18.0, extra_screeners * 6.0)
            score += bonus
            reasons.append(f"Present in {extra_screeners + 1} screeners")

        volume = candidate.get("volume")
        if volume is not None and volume >= 1_000_000:
            score += 5.0
            reasons.append(f"Volume {volume / 1_000_000:.1f}M")

        return max(0.0, min(100.0, score)), reasons

    @staticmethod
    def _score_manual(candidate: dict[str, Any]) -> tuple[float, list[str]]:
        """Score a user-selected ticker (no screener row required)."""
        change = candidate.get("change_pct")
        reasons = ["Manual watchlist selection"]
        min_score = float(DEFAULT_CONFIG["min_suggestion_score"])
        if change is not None and change > 0:
            score = min_score + min(25.0, float(change) * 2.0)
            reasons.append(f"Recent momentum +{float(change):.2f}%")
        else:
            score = min_score
        return max(0.0, min(100.0, score)), reasons

    async def scan_once(self) -> list[dict[str, Any]]:
        self._scanning = True
        try:
            return await self._scan_once_inner()
        finally:
            self._scanning = False
            self._last_scan_at = _now_iso()

    async def _scan_once_inner(self) -> list[dict[str, Any]]:
        store = get_agentic_session_store()
        min_score = float(DEFAULT_CONFIG["min_suggestion_score"])
        cooldown = float(DEFAULT_CONFIG["suggestion_cooldown_seconds"])
        now_mono = time.monotonic()

        running_sessions = await asyncio.to_thread(store.list_sessions_by_status, "running")
        screener_filter, ticker_env, manual_tickers = self._scan_scope(running_sessions)

        screener_candidates = await asyncio.to_thread(
            self._screener_candidates, screener_filter
        )
        manual_candidates = await self._manual_ticker_candidates(
            manual_tickers, ticker_env, screener_candidates
        )
        candidates = {**screener_candidates, **manual_candidates}
        self._last_scan_stats = {
            "candidates": len(candidates),
            "emitted": 0,
        }

        halted = await asyncio.to_thread(self._halted_symbols)
        tracker = get_halt_resume_tracker()
        resumed = await asyncio.to_thread(tracker.sync_halts, halted)
        if resumed:
            asyncio.create_task(reconcile_sessions_for_resumed_tickers(resumed))
        open_tickers = await asyncio.to_thread(store.open_tickers_for_running_sessions)

        emitted: list[dict[str, Any]] = []
        for ticker, candidate in candidates.items():
            price = candidate.get("price")
            change = candidate.get("change_pct")
            tracker.note_candidate_momentum(ticker, change if change is None else float(change))
            is_manual = candidate.get("source") == "manual"
            # Suspicious rows: no price or non-positive price.
            if price is None or price <= 0:
                continue
            if not is_manual and (change is None or change <= 0):
                continue
            if ticker in halted:
                continue
            if ticker in open_tickers:
                continue
            last = self._last_emitted.get(ticker)
            if last is not None and (now_mono - last) < cooldown:
                continue

            if is_manual:
                score, reasons = self._score_manual(candidate)
            else:
                score, reasons = self._score(candidate)
            if score < min_score:
                continue

            suggestion = {
                "id": uuid.uuid4().hex,
                "ticker": ticker,
                "score": round(score, 1),
                "source": candidate.get("source") or "screener",
                "source_screener": candidate["source_screener"],
                "screener_id": candidate.get("source_screener_id"),
                "reason": "; ".join(reasons),
                "price": float(price),
                "spread_pct": None,
                "generated_at": _now_iso(),
            }
            suggestion = tracker.decorate_suggestion(
                suggestion, DEFAULT_CONFIG, candidate=candidate
            )
            self._last_emitted[ticker] = now_mono
            self._suggestions.append(suggestion)
            emitted.append(suggestion)

            for queue in list(self._subscribers):
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(dict(suggestion))

        self._last_scan_stats["emitted"] = len(emitted)

        for session in running_sessions:
            config = session.get("config") or {}
            watchlist = self._session_watchlist(session)
            session_emitted = [
                s for s in emitted if self._suggestion_allowed_for_session(session, s)
            ]
            if self._is_watchlist_only(session):
                scope_count = len(watchlist)
                work = (
                    f"Watchlist only: {', '.join(sorted(watchlist)[:6])}"
                    if watchlist
                    else "Watchlist only"
                )
            else:
                scope_count = len(candidates)
                work = f"Watching {scope_count} candidates"
            SessionSnapshot(store, session["id"]).mutate(
                lambda state, work=work: state.setdefault(
                    "services", {}
                ).setdefault("market_hunter", {}).update(
                    {
                        "name": "market_hunter",
                        "kind": "deterministic",
                        "status": "active",
                        "last_run_at": self._last_scan_at or _now_iso(),
                        "current_work": work,
                    }
                )
            )
            bus = get_event_bus(
                session["id"],
                store,
                int(config.get("event_queue_size", DEFAULT_CONFIG["event_queue_size"])),
            )
            threshold = float(
                config.get("confidence_threshold", DEFAULT_CONFIG["confidence_threshold"])
            )
            for suggestion in session_emitted:
                event_threshold = (
                    float(DEFAULT_CONFIG["min_suggestion_score"])
                    if suggestion["ticker"] in watchlist or suggestion.get("source") == "manual"
                    else threshold
                )
                if float(suggestion["score"]) >= event_threshold:
                    await bus.publish(
                        AgentEvent(
                            session_id=session["id"],
                            type=EventType.CANDIDATE_FOUND,
                            tier=EventTier.FAST,
                            source="market_hunter",
                            ticker=suggestion["ticker"],
                            payload=dict(suggestion),
                            dedupe_key=f"candidate:{suggestion['ticker']}",
                        ),
                        dedupe_seconds=float(
                            config.get(
                                "event_dedupe_seconds",
                                DEFAULT_CONFIG["event_dedupe_seconds"],
                            )
                        ),
                    )
            if session_emitted:
                await asyncio.to_thread(
                    self._log_suggestions_to_sessions,
                    session_emitted,
                    [session],
                )
                await asyncio.to_thread(
                    self._heartbeat_sessions,
                    [session],
                    scope_count,
                    len(session_emitted),
                )

        # Hunter reasoning: {data, oneline, confidence} + thinking per running session.
        if running_sessions:
            from control_plane.agentic.agent_reasoning import schedule_hunter_thinking

            for session in running_sessions:
                watchlist = self._session_watchlist(session)
                session_emitted = [
                    s for s in emitted if self._suggestion_allowed_for_session(session, s)
                ]
                scoped_candidate_count = (
                    len(watchlist) if self._is_watchlist_only(session) else len(candidates)
                )
                await schedule_hunter_thinking(
                    session,
                    candidates_count=scoped_candidate_count,
                    emitted=session_emitted,
                    manual_tickers=sorted(watchlist),
                )
        if emitted:
            log.info(
                "[AGENTIC_HUNTER] Emitted %d suggestion(s): %s",
                len(emitted),
                ", ".join(f"{s['ticker']}={s['score']}" for s in emitted[:10]),
            )
        return emitted

    @staticmethod
    def _heartbeat_sessions(
        sessions: list[dict[str, Any]],
        candidates_count: int,
        emitted_count: int,
    ) -> None:
        store = get_agentic_session_store()
        text = (
            f"Hunter scanned {candidates_count} candidate(s), "
            f"{emitted_count} suggestion(s) emitted"
        )
        meta = {
            "candidates_count": candidates_count,
            "emitted_count": emitted_count,
            "heartbeat": True,
        }
        for session in sessions:
            store.add_event(session["id"], "info", text, meta=meta)

    @classmethod
    def _suggestion_allowed_for_session(
        cls,
        session: dict[str, Any],
        suggestion: dict[str, Any],
    ) -> bool:
        tickers = cls._session_watchlist(session)
        screener_ids = cls._session_screener_ids(session)
        ticker = _ticker_symbol(suggestion.get("ticker"))
        if ticker in tickers:
            return True
        # Watchlist-only: never accept screener movers outside the explicit list.
        if tickers and not screener_ids:
            return False
        if suggestion.get("source") == "manual":
            return False
        if not screener_ids:
            return True
        sid = suggestion.get("screener_id")
        return sid in screener_ids

    @staticmethod
    def _log_suggestions_to_sessions(
        suggestions: list[dict[str, Any]],
        sessions: list[dict[str, Any]],
    ) -> None:
        store = get_agentic_session_store()
        for session in sessions:
            config = session.get("config") or {}
            threshold = float(
                config.get("confidence_threshold", DEFAULT_CONFIG["confidence_threshold"])
            )
            for suggestion in suggestions:
                if not MarketHunter._suggestion_allowed_for_session(session, suggestion):
                    continue
                min_hunter = float(DEFAULT_CONFIG["min_suggestion_score"])
                ticker = str(suggestion.get("ticker") or "").upper()
                watchlist = {
                    str(t).upper()
                    for t in (config.get("tickers") or [])
                    if t
                }
                score = float(suggestion["score"])
                passes = score >= threshold
                if ticker in watchlist or suggestion.get("source") == "manual":
                    passes = score >= min_hunter
                if not passes:
                    continue
                store.add_event(
                    session["id"],
                    "suggestion",
                    f"{suggestion['ticker']} scored {suggestion['score']} "
                    f"({suggestion['source_screener']})",
                    ticker=suggestion["ticker"],
                    meta=dict(suggestion),
                )


_hunter: MarketHunter | None = None


def get_market_hunter() -> MarketHunter:
    global _hunter
    if _hunter is None:
        _hunter = MarketHunter()
    return _hunter
