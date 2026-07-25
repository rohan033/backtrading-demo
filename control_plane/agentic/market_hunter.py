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

from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.session_store import get_agentic_session_store

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

    def _screener_candidates(self) -> dict[str, dict[str, Any]]:
        """ticker -> best row info + list of screeners it appears in."""
        from control_plane.screener_store import get_screener_store

        candidates: dict[str, dict[str, Any]] = {}
        for screener in get_screener_store().list_screeners(include_results=True):
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
                        "change_pct": None,
                        "price": None,
                        "volume": None,
                        "best_rank": rank,
                        "source_screener": name,
                    },
                )
                entry["screeners"].append(name)
                change = _row_change_pct(cells)
                if change is not None and (
                    entry["change_pct"] is None or change > entry["change_pct"]
                ):
                    entry["change_pct"] = change
                    entry["source_screener"] = name
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

    async def scan_once(self) -> list[dict[str, Any]]:
        store = get_agentic_session_store()
        min_score = float(DEFAULT_CONFIG["min_suggestion_score"])
        cooldown = float(DEFAULT_CONFIG["suggestion_cooldown_seconds"])
        now_mono = time.monotonic()

        candidates = await asyncio.to_thread(self._screener_candidates)
        halted = await asyncio.to_thread(self._halted_symbols)
        open_tickers = await asyncio.to_thread(store.open_tickers_for_running_sessions)
        running_sessions = await asyncio.to_thread(store.list_sessions_by_status, "running")

        emitted: list[dict[str, Any]] = []
        for ticker, candidate in candidates.items():
            price = candidate.get("price")
            change = candidate.get("change_pct")
            # Suspicious rows: no price, non-positive price, or no positive momentum.
            if price is None or price <= 0:
                continue
            if change is None or change <= 0:
                continue
            if ticker in halted:
                continue
            if ticker in open_tickers:
                continue
            last = self._last_emitted.get(ticker)
            if last is not None and (now_mono - last) < cooldown:
                continue

            score, reasons = self._score(candidate)
            if score < min_score:
                continue

            suggestion = {
                "id": uuid.uuid4().hex,
                "ticker": ticker,
                "score": round(score, 1),
                "source_screener": candidate["source_screener"],
                "reason": "; ".join(reasons),
                "price": float(price),
                "spread_pct": None,
                "generated_at": _now_iso(),
            }
            self._last_emitted[ticker] = now_mono
            self._suggestions.append(suggestion)
            emitted.append(suggestion)

            for queue in list(self._subscribers):
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(dict(suggestion))

        if emitted and running_sessions:
            await asyncio.to_thread(
                self._log_suggestions_to_sessions, emitted, running_sessions
            )
        if emitted:
            log.info(
                "[AGENTIC_HUNTER] Emitted %d suggestion(s): %s",
                len(emitted),
                ", ".join(f"{s['ticker']}={s['score']}" for s in emitted[:10]),
            )
        return emitted

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
                if float(suggestion["score"]) < threshold:
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
