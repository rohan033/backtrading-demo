"""Per-session trading engine: entries, exit state machine, rotation, auto-stop.

One asyncio task per running session. Consumes market hunter suggestions,
sizes positions with confidence weighting under hard caps, places orders
(real eToro demo/live orders by default; set config.dry_run=true only for
local simulated fills with no broker call), and runs the Running -> Weakening -> Exit state machine on 5-minute
candle closes with a halt fast-path.

The exit machine only tightens or exits earlier: the hard stop set at
placement is never loosened.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.broker import (
    close_broker_position,
    compute_atr,
    fetch_five_minute_candles,
    fetch_quote,
    last_closed_candle,
    place_market_buy_with_stop,
)
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.market_hunter import MarketHunter, get_market_hunter
from control_plane.agentic.playbooks import create_playbook, rotation_edge
from control_plane.agentic.snapshot import SessionSnapshot
from control_plane.agentic.session_store import (
    ACTIVE_POSITION_STATES,
    get_agentic_session_store,
)

log = logging.getLogger("backtrading")

CANDLE_FETCH_COUNT = 60  # ~5 hours of 5m bars; plenty for ATR(14) + structure

# Session engine executes orchestrator-approved trades; attribute logs accordingly.
_ORCH_META = {"provenance": "main_orchestrator", "agent": "main_orchestrator"}


def _orch_meta(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    merged = dict(_ORCH_META)
    if extra:
        merged.update(extra)
    return merged


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cfg(session: dict[str, Any], key: str) -> Any:
    config = session.get("config") or {}
    return config.get(key, DEFAULT_CONFIG[key])


def _entries_allowed(session: dict[str, Any]) -> bool:
    return session.get("status") == "running" and not session.get("stop_reason")


def _watchlist_tickers(session: dict[str, Any]) -> set[str]:
    return {
        str(t).upper()
        for t in ((session.get("config") or {}).get("tickers") or [])
        if t
    }


def _meets_entry_threshold(session: dict[str, Any], suggestion: dict[str, Any]) -> bool:
    """Watchlist / manual picks only need the hunter floor; screeners use confidence_threshold."""
    score = float(suggestion.get("score") or 0)
    threshold = float(_cfg(session, "confidence_threshold"))
    min_hunter = float(DEFAULT_CONFIG["min_suggestion_score"])
    ticker = str(suggestion.get("ticker") or "").upper()
    if ticker in _watchlist_tickers(session) or suggestion.get("source") == "manual":
        return score >= min_hunter
    return score >= threshold


def _allocation_weight(session: dict[str, Any], suggestion: dict[str, Any]) -> float:
    """Confidence-weighted sizing; watchlist picks weight from hunter floor upward."""
    threshold = float(_cfg(session, "confidence_threshold"))
    min_hunter = float(DEFAULT_CONFIG["min_suggestion_score"])
    score = float(suggestion.get("score") or 0)
    ticker = str(suggestion.get("ticker") or "").upper()
    base = min_hunter if (
        ticker in _watchlist_tickers(session) or suggestion.get("source") == "manual"
    ) else threshold
    span = max(1.0, 100.0 - base)
    return 0.5 + 0.5 * min(1.0, max(0.0, (score - base) / span))


# ── Close plumbing (shared by engine loop and the manual-close API) ──


async def close_position_now(
    session: dict[str, Any],
    position: dict[str, Any],
    *,
    fraction: float = 1.0,
    reason: str = "manual",
    exit_price: float | None = None,
) -> dict[str, Any]:
    """Close (or trim) one position. Dry-run simulates the fill at exit_price;
    real mode places a broker close and lets reconciliation settle exact PnL."""
    store = get_agentic_session_store()
    session_id = session["id"]
    position_id = position["id"]
    fraction = min(1.0, max(0.0, float(fraction)))
    if fraction <= 0 or position["state"] not in ("open",):
        return position

    units_total = float(position["units"] or 0.0)
    units_to_close = units_total if fraction >= 0.999 else units_total * fraction
    buy_price = float(position["buy_price"] or 0.0)
    price = float(
        exit_price
        if exit_price is not None
        else (position.get("current_price") or buy_price)
    )
    dry_run = bool(_cfg(session, "dry_run"))
    full_close = units_to_close >= units_total - 1e-9
    event_type = "exit" if full_close else "trim"

    if dry_run:
        realized_delta = (price - buy_price) * units_to_close
        remaining = 0.0 if full_close else units_total - units_to_close
        fields: dict[str, Any] = {
            "units": remaining,
            "current_price": price,
            "realized_pnl": float(position["realized_pnl"] or 0.0) + realized_delta,
            "unrealized_pnl": (price - buy_price) * remaining,
        }
        if full_close:
            fields["state"] = "closed"
            fields["closed_at"] = _now_iso()
        updated = store.update_position(position_id, fields) or position
        store.add_event(
            session_id,
            event_type,
            f"{'Closed' if full_close else 'Trimmed'} {position['ticker']} "
            f"{units_to_close:.4f}u @ {price:.4f} ({reason}) [dry-run] "
            f"pnl={realized_delta:+.2f}",
            ticker=position["ticker"],
            meta=_orch_meta({
                "position_id": position_id,
                "reason": reason,
                "fraction": fraction,
                "exit_price": price,
                "realized_delta": realized_delta,
                "dry_run": True,
            }),
        )
        if full_close:
            from control_plane.agentic.reconciliation import _release_hunter_ticker

            _release_hunter_ticker(str(position.get("ticker") or ""))
        return updated

    # REAL close path.
    store.update_position(position_id, {"state": "pending_close"})
    try:
        await close_broker_position(
            session["account_env"],
            position["ticker"],
            str(position.get("broker_position_id") or ""),
            units=None if full_close else units_to_close,
        )
    except Exception as exc:
        store.add_event(
            session_id,
            "error",
            f"Broker close failed for {position['ticker']}: {exc}",
            ticker=position["ticker"],
            meta={"position_id": position_id, "reason": reason},
        )
        # Leave in pending_close; the reconciliation loop retries and alerts.
        return store.get_position(position_id) or position

    # Estimate realized PnL at the observed price; reconciliation replaces this
    # with the broker's actual fill data once the closed trade settles.
    realized_delta = (price - buy_price) * units_to_close
    remaining = 0.0 if full_close else units_total - units_to_close
    fields = {
        "units": remaining,
        "current_price": price,
        "realized_pnl": float(position["realized_pnl"] or 0.0) + realized_delta,
        "unrealized_pnl": (price - buy_price) * remaining,
        "state": "closed" if full_close else "open",
    }
    if full_close:
        fields["closed_at"] = _now_iso()
    updated = store.update_position(position_id, fields) or position
    store.add_event(
        session_id,
        event_type,
        f"{'Closed' if full_close else 'Trimmed'} {position['ticker']} "
        f"{units_to_close:.4f}u @ ~{price:.4f} ({reason}) pnl~{realized_delta:+.2f}",
        ticker=position["ticker"],
        meta=_orch_meta({
            "position_id": position_id,
            "reason": reason,
            "fraction": fraction,
            "exit_price": price,
            "realized_delta": realized_delta,
            "dry_run": False,
        }),
    )
    if full_close:
        from control_plane.agentic.reconciliation import _release_hunter_ticker

        _release_hunter_ticker(str(position.get("ticker") or ""))
    return updated


class SessionEngine:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.store = get_agentic_session_store()
        self._queue: asyncio.Queue | None = None
        # position_id -> time of last evaluated closed 5m candle
        self._last_candle_eval: dict[str, int] = {}
        # ticker -> monotonic timestamp of last state transition (debounce)
        self._last_action: dict[str, float] = {}
        # position_id -> latest ascending candles (rotation momentum input)
        self._candles: dict[str, list[dict[str, Any]]] = {}

    # ── Main loop ──

    async def run(self) -> None:
        hunter = get_market_hunter()
        self._queue = hunter.subscribe()
        log.info("[AGENTIC_ENGINE] Session %s loop started", self.session_id)
        session = self.store.get_session(self.session_id)
        try:
            while True:
                session = self.store.get_session(self.session_id)
                if session is None:
                    return  # deleted
                if session["status"] == "stopped":
                    log.info(
                        "[AGENTIC_ENGINE] Session %s stopped; exiting loop",
                        self.session_id,
                    )
                    return

                try:
                    await self._drain_suggestions(session)
                except Exception as exc:
                    log.error(
                        "[AGENTIC_ENGINE] Entry pipeline failed session=%s: %s",
                        self.session_id,
                        exc,
                        exc_info=True,
                    )
                try:
                    await self._manage_exits(session)
                except Exception as exc:
                    log.error(
                        "[AGENTIC_ENGINE] Exit management failed session=%s: %s",
                        self.session_id,
                        exc,
                        exc_info=True,
                    )

                await asyncio.sleep(max(5.0, float(_cfg(session, "exit_poll_seconds"))))
        except asyncio.CancelledError:
            raise
        finally:
            if self._queue is not None:
                hunter.unsubscribe(self._queue)

    # ── Entry pipeline ──

    async def _drain_suggestions(self, session: dict[str, Any]) -> None:
        if self._queue is None:
            return
        suggestions: list[dict[str, Any]] = []
        while True:
            try:
                suggestions.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if not _entries_allowed(session):
            return
        scoped = [
            s
            for s in suggestions
            if MarketHunter._suggestion_allowed_for_session(session, s)
        ]
        threshold = float(_cfg(session, "confidence_threshold"))
        for suggestion in scoped:
            ticker = str(suggestion.get("ticker") or "").upper()
            score = float(suggestion.get("score") or 0)
            if not _meets_entry_threshold(session, suggestion):
                from control_plane.agentic.agent_reasoning import _emit_synthetic

                _emit_synthetic(
                    self.session_id,
                    agent="session",
                    ticker=ticker,
                    lines=[
                        f"Received {ticker} suggestion (score {score}) — below threshold {threshold}.",
                        "Screener picks need score ≥ confidence threshold; watchlist picks need ≥ 40.",
                        f"Reason: {suggestion.get('reason') or suggestion.get('source_screener')}.",
                    ],
                )
        actionable = [s for s in scoped if _meets_entry_threshold(session, s)]
        # Best candidates first so caps go to the highest-confidence names.
        actionable.sort(key=lambda s: float(s["score"]), reverse=True)
        for suggestion in actionable:
            session = self.store.get_session(self.session_id) or session
            if not _entries_allowed(session):
                return
            self.store.add_event(
                self.session_id,
                "info",
                f"Evaluating {suggestion['ticker']} (score {suggestion['score']})",
                ticker=str(suggestion["ticker"]),
                meta={
                    "evaluating": True,
                    "score": suggestion["score"],
                    "source": suggestion.get("source"),
                },
            )
            await self._try_enter(session, suggestion)

    def _invested_amount(self) -> float:
        return float(self.store.session_stats(self.session_id)["invested"])

    async def _try_enter(self, session: dict[str, Any], suggestion: dict[str, Any]) -> None:
        ticker = str(suggestion["ticker"]).upper()
        # Idempotency: never act while a pending_open/pending_close is in flight.
        if self.store.active_position_for_ticker(self.session_id, ticker):
            return
        if not self._debounce_ok(ticker, session):
            return

        start_balance = float(session["start_balance"] or 0.0)
        per_cap = start_balance * float(_cfg(session, "per_position_cap_pct")) / 100.0
        exposure_cap = start_balance * float(_cfg(session, "total_exposure_cap_pct")) / 100.0
        min_alloc = float(_cfg(session, "min_allocation_usd"))
        invested = self._invested_amount()
        headroom = exposure_cap - invested

        if headroom < min_alloc:
            rotated = await self._try_rotation(session, suggestion)
            if not rotated:
                return
            headroom = exposure_cap - self._invested_amount()
            if headroom < min_alloc:
                return

        # Per-candidate data in parallel.
        quote, candles = await asyncio.gather(
            fetch_quote(session["account_env"], ticker),
            fetch_five_minute_candles(
                session["account_env"], ticker, count=CANDLE_FETCH_COUNT
            ),
        )
        price = float(
            (quote or {}).get("price") or suggestion.get("price") or 0.0
        )
        if price <= 0:
            self.store.add_event(
                self.session_id,
                "error",
                f"Cannot enter {ticker}: no live quote from broker",
                ticker=ticker,
                meta={"score": suggestion.get("score"), "quote": quote},
            )
            return

        atr = compute_atr(candles, period=int(_cfg(session, "atr_period")))
        if atr and atr > 0:
            stop_loss = price - float(_cfg(session, "stop_loss_atr_multiple")) * atr
        else:
            stop_loss = price * (1.0 - float(_cfg(session, "stop_loss_fallback_pct")) / 100.0)
        stop_loss = max(0.0001, min(stop_loss, price * 0.999))

        # Confidence-weighted allocation inside the hard caps.
        weight = _allocation_weight(session, suggestion)
        allocation = min(per_cap * weight, headroom)
        if allocation < min_alloc:
            self.store.add_event(
                self.session_id,
                "info",
                f"Skipped {ticker}: allocation ${allocation:.2f} below minimum ${min_alloc:.2f}",
                ticker=ticker,
                meta={"allocation": allocation, "headroom": headroom},
            )
            return
        units = allocation / price
        intent_id = uuid.uuid4().hex
        dry_run = bool(_cfg(session, "dry_run"))

        # Session agent reasoning: {data, oneline, confidence} + streaming thinking.
        from control_plane.agentic.agent_reasoning import schedule_session_thinking

        await schedule_session_thinking(
            session,
            suggestion,
            price=price,
            atr=atr,
            allocation=allocation,
            headroom=headroom,
        )

        if not await get_agentic_session_manager().evaluate_candidate(
            self.session_id, suggestion
        ):
            self.store.add_event(
                self.session_id,
                "info",
                f"Orchestrator declined or deferred {ticker}",
                ticker=ticker,
                meta=_orch_meta({"score": suggestion.get("score"), "provenance": "main_orchestrator"}),
            )
            return

        position = self.store.create_position(
            self.session_id,
            ticker=ticker,
            units=units,
            buy_price=price,
            stop_loss=stop_loss,
            intent_id=intent_id,
            state="pending_open",
        )
        self._mark_action(ticker)

        if dry_run:
            # Simulated fill at the current price; logged identically to real.
            self.store.update_position(
                position["id"],
                {"state": "open", "opened_at": _now_iso(), "trail_peak": price},
            )
            self.store.add_event(
                self.session_id,
                "entry",
                f"Opened {ticker} {units:.4f}u @ {price:.4f} stop={stop_loss:.4f} "
                f"(${allocation:.2f}, score {suggestion['score']}) [dry-run]",
                ticker=ticker,
                meta=_orch_meta({
                    "position_id": position["id"],
                    "intent_id": intent_id,
                    "allocation": allocation,
                    "score": suggestion["score"],
                    "atr": atr,
                    "stop_loss": stop_loss,
                    "suggestion_id": suggestion.get("id"),
                    "dry_run": True,
                }),
            )
            opened = self.store.get_position(position["id"]) or position
            self._persist_playbook(opened, suggestion, atr)
            return

        # REAL order path — stop loss attached at placement, never optional.
        try:
            result = await place_market_buy_with_stop(
                session["account_env"],
                ticker,
                amount_usd=allocation,
                reference_price=price,
                stop_loss=stop_loss,
            )
        except Exception as exc:
            self.store.update_position(position["id"], {"state": "failed"})
            self.store.add_event(
                self.session_id,
                "error",
                f"Broker BUY failed for {ticker}: {exc}",
                ticker=ticker,
                meta={"position_id": position["id"], "intent_id": intent_id},
            )
            return

        self.store.update_position(
            position["id"],
            {
                "trail_peak": price,
                "stop_loss": float(result.get("stop_loss_rate") or stop_loss),
                "broker_position_id": result.get("broker_position_id"),
            },
        )
        if result.get("broker_position_id"):
            self.store.update_position(
                position["id"],
                {"state": "open", "opened_at": _now_iso()},
            )
        self.store.add_event(
            self.session_id,
            "entry",
            f"{'Opened' if result.get('broker_position_id') else 'Submitted'} {ticker} "
            f"~{units:.4f}u @ ~{price:.4f} stop={stop_loss:.4f} "
            f"(${allocation:.2f}, score {suggestion['score']}) order={result.get('order_id')}",
            ticker=ticker,
            meta=_orch_meta({
                "position_id": position["id"],
                "intent_id": intent_id,
                "order_id": result.get("order_id"),
                "broker_position_id": result.get("broker_position_id"),
                "allocation": allocation,
                "score": suggestion["score"],
                "dry_run": False,
                "pending_fill": not bool(result.get("broker_position_id")),
            }),
        )
        if not result.get("broker_position_id"):
            return
        opened = self.store.get_position(position["id"]) or position
        self._persist_playbook(opened, suggestion, atr)

    def _persist_playbook(
        self,
        position: dict[str, Any],
        suggestion: dict[str, Any],
        atr: float | None,
    ) -> None:
        playbook = create_playbook(position, suggestion, atr=atr)
        SessionSnapshot(self.store, self.session_id).mutate(
            lambda snapshot: snapshot.setdefault("playbooks", {}).__setitem__(
                position["id"], playbook
            )
        )
        self.store.add_event(
            self.session_id,
            "playbook",
            f"Trade playbook created for {position['ticker']}",
            ticker=position["ticker"],
            meta=_orch_meta({"position_id": position["id"], "playbook": playbook}),
        )

    # ── Rotation ──

    def _position_momentum_score(self, position: dict[str, Any]) -> float:
        """Deterministic 0-100 momentum proxy from the last ~30 min of 5m candles."""
        candles = self._candles.get(position["id"]) or []
        closes = [float(c["close"]) for c in candles[-7:] if c.get("close")]
        if len(closes) < 2 or closes[0] <= 0:
            return 50.0
        pct = (closes[-1] - closes[0]) / closes[0] * 100.0
        return max(0.0, min(100.0, 50.0 + pct * 4.0))

    async def _try_rotation(
        self, session: dict[str, Any], suggestion: dict[str, Any]
    ) -> bool:
        margin = float(_cfg(session, "rotation_margin"))
        open_positions = [
            p
            for p in self.store.list_positions(self.session_id, states=("open",))
            if self._debounce_ok(p["ticker"], session)
        ]
        if not open_positions:
            return False
        scored = [(self._position_momentum_score(p), p) for p in open_positions]
        weakest_score, weakest = min(scored, key=lambda item: item[0])
        edge = rotation_edge(
            candidate_score=float(suggestion["score"]),
            holding_score=weakest_score,
            slippage_bps=float(_cfg(session, "rotation_slippage_bps")),
            edge_margin_pct=float(_cfg(session, "rotation_edge_margin_pct")),
        )
        if (
            float(suggestion["score"]) <= weakest_score + margin
            or not edge["rotate"]
        ):
            return False

        self.store.add_event(
            self.session_id,
            "state_change",
            f"Rotation: closing {weakest['ticker']} (momentum {weakest_score:.0f}) "
            f"for {suggestion['ticker']} (score {suggestion['score']})",
            ticker=weakest["ticker"],
            meta=_orch_meta({
                "position_id": weakest["id"],
                "candidate": suggestion["ticker"],
                "candidate_score": suggestion["score"],
                "momentum_score": weakest_score,
                "margin": margin,
                "edge": edge,
            }),
        )
        self._mark_action(weakest["ticker"])
        await close_position_now(
            session,
            weakest,
            fraction=1.0,
            reason=f"rotation for {suggestion['ticker']}",
        )
        self._check_autonomous_stop(session)
        return True

    # ── Exit state machine ──

    async def _manage_exits(self, session: dict[str, Any]) -> None:
        open_positions = self.store.list_positions(self.session_id, states=("open",))
        if not open_positions:
            return

        halted_down = await asyncio.to_thread(self._down_halted_symbols)

        candle_batches = await asyncio.gather(
            *(
                fetch_five_minute_candles(
                    session["account_env"], p["ticker"], count=CANDLE_FETCH_COUNT
                )
                for p in open_positions
            )
        )
        for position, candles in zip(open_positions, candle_batches):
            try:
                await self._evaluate_position(session, position, candles, halted_down)
            except Exception as exc:
                log.error(
                    "[AGENTIC_ENGINE] Evaluate failed %s/%s: %s",
                    self.session_id,
                    position["ticker"],
                    exc,
                    exc_info=True,
                )
        self._check_autonomous_stop(session)

    def _down_halted_symbols(self) -> set[str]:
        """Currently-halted symbols whose recent tape points down (fast-path exits)."""
        try:
            from control_plane.trade_halts_store import get_trade_halts_store

            rows = get_trade_halts_store().list_all_halts()
        except Exception:
            return set()
        return {
            str(row.get("symbol") or "").upper()
            for row in rows
            if str(row.get("status") or "").lower() == "halted"
        }

    async def _evaluate_position(
        self,
        session: dict[str, Any],
        position: dict[str, Any],
        candles: list[dict[str, Any]],
        halted_symbols: set[str],
    ) -> None:
        store = self.store
        position_id = position["id"]
        ticker = position["ticker"]
        if candles:
            self._candles[position_id] = candles

        price = float(
            (candles[-1]["close"] if candles else 0.0)
            or position.get("current_price")
            or position.get("buy_price")
            or 0.0
        )
        from control_plane.agentic.live_feed import get_ws_price

        ws_price = get_ws_price(self.session_id, ticker, session.get("account_env") or "demo")
        if ws_price is not None and ws_price > 0:
            price = ws_price
        if price <= 0:
            return
        from control_plane.agentic.profit_price_tracker import get_profit_price_tracker

        get_profit_price_tracker().record(self.session_id, ticker, price, source="websocket")
        buy_price = float(position["buy_price"] or 0.0)
        units = float(position["units"] or 0.0)
        store.update_position(
            position_id,
            {
                "current_price": price,
                "unrealized_pnl": (price - buy_price) * units,
            },
        )
        position = store.get_position(position_id) or position

        # Halt fast-path: down-halt while held -> direct Exit, no candle wait.
        if ticker in halted_symbols and self._is_downtrending(candles):
            store.add_event(
                self.session_id,
                "state_change",
                f"{ticker} down-halt while held — fast-path exit",
                ticker=ticker,
                meta=_orch_meta({"position_id": position_id, "from": position["exit_state"], "to": "exit"}),
            )
            store.update_position(position_id, {"exit_state": "exit"})
            await close_position_now(session, position, reason="down-halt", exit_price=price)
            self._mark_action(ticker)
            return

        atr = compute_atr(candles, period=int(_cfg(session, "atr_period")))
        if not atr or atr <= 0:
            atr = max(price * 0.01, 0.0001)

        hard_stop = float(position["stop_loss"] or 0.0)
        trail_peak = max(float(position.get("trail_peak") or buy_price), price)
        if candles:
            trail_peak = max(trail_peak, float(candles[-1]["high"] or price))
        store.update_position(position_id, {"trail_peak": trail_peak})

        exit_state = position["exit_state"]
        trail_mult = (
            float(_cfg(session, "trail_atr_multiple_weakening"))
            if exit_state == "weakening"
            else float(_cfg(session, "trail_atr_multiple_running"))
        )
        trail_stop = trail_peak - trail_mult * atr
        # The machine only tightens: effective stop never sits below the hard stop.
        effective_stop = max(hard_stop, trail_stop)

        if price <= effective_stop:
            store.add_event(
                self.session_id,
                "state_change",
                f"{ticker} hit stop {effective_stop:.4f} "
                f"({'trail' if trail_stop >= hard_stop else 'hard stop'}) — exit",
                ticker=ticker,
                meta=_orch_meta({
                    "position_id": position_id,
                    "from": exit_state,
                    "to": "exit",
                    "effective_stop": effective_stop,
                    "price": price,
                }),
            )
            store.update_position(position_id, {"exit_state": "exit"})
            await close_position_now(session, position, reason="stop hit", exit_price=price)
            self._mark_action(ticker)
            return

        # Structure transitions only on a newly closed 5-minute candle.
        closed = last_closed_candle(candles, now_epoch=time.time())
        if closed is None:
            return
        closed_ts = int(closed["time"])
        if self._last_candle_eval.get(position_id) == closed_ts:
            return
        self._last_candle_eval[position_id] = closed_ts

        prior = next(
            (c for c in reversed(candles) if int(c["time"]) < closed_ts),
            None,
        )
        if prior is None:
            return
        low_undercut = float(closed["low"]) < float(prior["low"])
        higher_low = float(closed["low"]) > float(prior["low"])

        if exit_state == "running" and low_undercut and self._debounce_ok(ticker, session):
            trim_fraction = float(_cfg(session, "weakening_trim_fraction"))
            store.update_position(position_id, {"exit_state": "weakening"})
            store.add_event(
                self.session_id,
                "state_change",
                f"{ticker} Running → Weakening (low {closed['low']:.4f} undercut "
                f"{prior['low']:.4f}); trimming {trim_fraction * 100:.0f}%, trail 1x ATR",
                ticker=ticker,
                meta=_orch_meta({
                    "position_id": position_id,
                    "from": "running",
                    "to": "weakening",
                    "candle_time": closed_ts,
                }),
            )
            self._mark_action(ticker)
            refreshed = store.get_position(position_id)
            if refreshed and refreshed["state"] == "open":
                await close_position_now(
                    session,
                    refreshed,
                    fraction=trim_fraction,
                    reason="weakening trim",
                    exit_price=price,
                )
        elif exit_state == "weakening" and higher_low and self._debounce_ok(ticker, session):
            store.update_position(position_id, {"exit_state": "running"})
            store.add_event(
                self.session_id,
                "state_change",
                f"{ticker} Weakening → Running (higher low reconfirmed); trail back to 3x ATR",
                ticker=ticker,
                meta=_orch_meta({
                    "position_id": position_id,
                    "from": "weakening",
                    "to": "running",
                    "candle_time": closed_ts,
                }),
            )
            self._mark_action(ticker)

    @staticmethod
    def _is_downtrending(candles: list[dict[str, Any]]) -> bool:
        """True when the last two 5m closes are falling (or no data to prove otherwise)."""
        closes = [float(c["close"]) for c in candles[-3:] if c.get("close")]
        if len(closes) < 2:
            return True  # halted with no candle info: treat as down per plan
        return closes[-1] <= closes[0]

    # ── Autonomous stop (deterministic circuit breaker) ──

    def _check_autonomous_stop(self, session: dict[str, Any]) -> None:
        session = self.store.get_session(self.session_id) or session
        if not _entries_allowed(session):
            return
        start_balance = float(session["start_balance"] or 0.0)
        if start_balance <= 0:
            return
        stats = self.store.session_stats(self.session_id)
        max_drawdown_pct = float(_cfg(session, "max_drawdown_pct"))
        max_losses = int(_cfg(session, "max_consecutive_losses"))

        reason: str | None = None
        realized = float(stats["realized_pnl"])
        if realized <= -start_balance * max_drawdown_pct / 100.0:
            reason = (
                f"Realized drawdown {realized:.2f} breached "
                f"{max_drawdown_pct:.0f}% of start balance"
            )
        else:
            recent = self.store.recent_closed_positions(self.session_id, limit=max_losses)
            if len(recent) >= max_losses and all(
                float(p["realized_pnl"] or 0.0) < 0 for p in recent
            ):
                reason = f"{max_losses} consecutive losing closes"

        if reason:
            # Block new entries; keep managing open positions. No force-liquidation.
            self.store.update_session(self.session_id, {"stop_reason": reason})
            self.store.add_event(
                self.session_id,
                "stop",
                f"Autonomous stop: {reason}. New entries blocked; "
                "open positions continue through the exit state machine.",
                meta={"stats": stats},
            )
            log.warning(
                "[AGENTIC_ENGINE] Autonomous stop session=%s: %s", self.session_id, reason
            )

    # ── Debounce ──

    def _debounce_ok(self, ticker: str, session: dict[str, Any]) -> bool:
        last = self._last_action.get(ticker.upper())
        if last is None:
            return True
        return (time.monotonic() - last) >= float(_cfg(session, "action_debounce_seconds"))

    def _mark_action(self, ticker: str) -> None:
        self._last_action[ticker.upper()] = time.monotonic()


class AgenticSessionManager:
    """Owns one SessionEngine task per session; resumes running sessions at boot."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}
        self._engines: dict[str, SessionEngine] = {}
        self._orchestrators: dict[str, Any] = {}
        self._service_managers: dict[str, Any] = {}

    async def startup(self) -> None:
        from control_plane.agentic.live_feed import startup as start_agentic_feed

        await start_agentic_feed()
        store = get_agentic_session_store()
        running = store.list_sessions_by_status("running")
        for session in running:
            self.start_session(session["id"])
        if running:
            log.info("[AGENTIC_ENGINE] Resumed %d running session(s)", len(running))

    async def shutdown(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        for task in list(self._tasks.values()):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()
        self._engines.clear()
        for manager in list(self._service_managers.values()):
            await manager.stop()
        self._service_managers.clear()
        self._orchestrators.clear()

    def start_session(self, session_id: str) -> None:
        existing = self._tasks.get(session_id)
        if existing and not existing.done():
            return
        engine = SessionEngine(session_id)
        self._engines[session_id] = engine
        session = get_agentic_session_store().get_session(session_id) or {}
        config = session.get("config") or {}
        from control_plane.agentic.events import get_event_bus
        from control_plane.agentic.orchestrator import TradingOrchestrator
        from control_plane.agentic.services import ServiceLifecycleManager

        bus = get_event_bus(
            session_id,
            get_agentic_session_store(),
            int(config.get("event_queue_size", DEFAULT_CONFIG["event_queue_size"])),
        )
        orchestrator = TradingOrchestrator(session_id, get_agentic_session_store(), bus)
        self._orchestrators[session_id] = orchestrator
        orchestrator_task = asyncio.create_task(
            orchestrator.run(), name=f"agentic-orchestrator-{session_id}"
        )
        self._tasks[f"{session_id}:orchestrator"] = orchestrator_task
        services = ServiceLifecycleManager(session_id, get_agentic_session_store(), bus)
        services.start()
        self._service_managers[session_id] = services
        task = asyncio.create_task(engine.run(), name=f"agentic-session-{session_id}")
        task.add_done_callback(lambda _t, sid=session_id: self._on_done(sid))
        self._tasks[session_id] = task
        asyncio.create_task(
            get_market_hunter().scan_once(),
            name=f"agentic-hunter-kick-{session_id[:8]}",
        )
        from control_plane.agentic.live_feed import refresh_agentic_feed_subscriptions

        asyncio.create_task(
            refresh_agentic_feed_subscriptions(),
            name=f"agentic-feed-sync-{session_id[:8]}",
        )

    def _on_done(self, session_id: str) -> None:
        self._tasks.pop(session_id, None)
        self._engines.pop(session_id, None)
        orchestrator_task = self._tasks.pop(f"{session_id}:orchestrator", None)
        if orchestrator_task and not orchestrator_task.done():
            orchestrator_task.cancel()
        services = self._service_managers.pop(session_id, None)
        if services:
            asyncio.create_task(
                services.stop(), name=f"agentic-services-stop-{session_id[:8]}"
            )
        self._orchestrators.pop(session_id, None)
        from control_plane.agentic.events import remove_event_bus
        from control_plane.agentic.live_feed import refresh_agentic_feed_subscriptions
        from control_plane.agentic.profit_price_tracker import get_profit_price_tracker

        get_profit_price_tracker().clear_session(session_id)
        remove_event_bus(session_id)
        asyncio.create_task(
            refresh_agentic_feed_subscriptions(),
            name=f"agentic-feed-sync-stop-{session_id[:8]}",
        )

    async def evaluate_candidate(
        self, session_id: str, suggestion: dict[str, Any]
    ) -> bool:
        orchestrator = self._orchestrators.get(session_id)
        if orchestrator is None:
            return False
        return await orchestrator.evaluate_candidate(suggestion)

    async def stop_session(self, session_id: str, reason: str = "Stopped by user") -> dict[str, Any] | None:
        """STOP: mark stopped and immediately halt engine, orchestrator, and monitors.

        Open broker positions are left as-is (close them manually from the UI);
        no background agent keeps managing them after Stop.
        """
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        if session is None:
            return None
        if session["status"] != "stopped":
            session = store.stop_session(session_id, reason)
            store.add_event(
                session_id,
                "stop",
                f"Session stopped: {reason}. All background agents halted.",
            )
        self.halt_background(session_id, reason=reason)
        return store.get_session(session_id) or session

    def halt_background(self, session_id: str, *, reason: str = "Stopped by user") -> None:
        """Cancel engine/orchestrator/service tasks and clear Agents Status."""
        from control_plane.agentic.snapshot import SessionSnapshot

        SessionSnapshot(get_agentic_session_store(), session_id).mark_halted(reason)
        self.stop_engine_task(session_id)

    async def halt_subagents(self, session_id: str) -> dict[str, Any] | None:
        """Stop spawning/thinking sub-agents; risk monitors and exits keep running."""
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        if session is None or session["status"] == "stopped":
            return session
        from control_plane.agentic.agent_reasoning import cancel_session_agent_tasks
        from control_plane.agentic.snapshot import SessionSnapshot

        SessionSnapshot(store, session_id).set_subagents_halted(
            True, reason="Subagents halted by user"
        )
        await cancel_session_agent_tasks(session_id)
        store.add_event(
            session_id,
            "info",
            "Subagents halted: no new LLM/sub-agent work until resumed. Risk exits stay active.",
            meta={"provenance": "user", "subagents_halted": True},
        )
        return store.get_session(session_id)

    async def resume_subagents(self, session_id: str) -> dict[str, Any] | None:
        """Allow orchestrator sub-agents and hunter/session thinking again."""
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        if session is None or session["status"] == "stopped":
            return session
        from control_plane.agentic.snapshot import SessionSnapshot

        SessionSnapshot(store, session_id).set_subagents_halted(
            False, reason="Subagents resumed by user"
        )
        store.add_event(
            session_id,
            "info",
            "Subagents resumed: orchestrator and hunter reasoning enabled.",
            meta={"provenance": "user", "subagents_halted": False},
        )
        return store.get_session(session_id)

    def pause_session(self, session_id: str) -> dict[str, Any] | None:
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        if session is None or session["status"] == "stopped":
            return session
        updated = store.update_session(session_id, {"status": "paused"})
        store.add_event(
            session_id,
            "info",
            "Session paused: new entries and LLM wakeups are suspended; risk exits remain active.",
            meta={"provenance": "user", "risk_monitoring_continues": True},
        )
        return updated

    def resume_session(self, session_id: str) -> dict[str, Any] | None:
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        if session is None or session["status"] == "stopped":
            return session
        updated = store.update_session(session_id, {"status": "running"})
        store.add_event(
            session_id,
            "info",
            "Session resumed: event-driven orchestration enabled.",
            meta={"provenance": "user"},
        )
        return updated

    def stop_engine_task(self, session_id: str) -> None:
        """Cancel the session engine; `_on_done` also kills orchestrator + services."""
        task = self._tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            return
        # Engine already gone (or never started) — still tear down siblings.
        self._on_done(session_id)

    async def force_close_position(
        self, session_id: str, position_id: str
    ) -> dict[str, Any] | None:
        store = get_agentic_session_store()
        session = store.get_session(session_id)
        position = store.get_position(position_id)
        if session is None or position is None or position["session_id"] != session_id:
            return None
        if position["state"] != "open":
            return position
        quote = await fetch_quote(session["account_env"], position["ticker"])
        exit_price = (quote or {}).get("price")
        return await close_position_now(
            session,
            position,
            fraction=1.0,
            reason="manual close",
            exit_price=float(exit_price) if exit_price else None,
        )


_manager: AgenticSessionManager | None = None


def get_agentic_session_manager() -> AgenticSessionManager:
    global _manager
    if _manager is None:
        _manager = AgenticSessionManager()
    return _manager
