"""Halt-resume execution: re-eligibility, up-halt scoring, halt-aware reconciliation hooks."""

from __future__ import annotations

import logging
import time
from datetime import date
from typing import Any

from control_plane.agentic.config import DEFAULT_CONFIG

log = logging.getLogger("backtrading")

_UP_HALT_REASON_PREFIXES = ("LUP", "VOLatility", "VOL")


def get_halted_symbols() -> set[str]:
    try:
        from control_plane.trade_halts_store import get_trade_halts_store

        rows = get_trade_halts_store().list_all_halts()
    except Exception as exc:
        log.debug("[HALT_EXEC] halts lookup failed: %s", exc)
        return set()
    return {
        str(row.get("symbol") or "").strip().upper()
        for row in rows
        if str(row.get("status") or "").lower() == "halted" and row.get("symbol")
    }


def _is_up_halt_reason(reason_code: str | None) -> bool:
    code = str(reason_code or "").strip().upper()
    if not code:
        return False
    return any(code.startswith(prefix.upper()) for prefix in _UP_HALT_REASON_PREFIXES) or code in {
        "LUDP",
        "LULD",
    }


def _count_up_halts_today(ticker: str) -> int:
    try:
        from control_plane.trade_halts_store import get_trade_halts_store

        rows = get_trade_halts_store().list_halts_for_symbol(
            ticker, day=date.today().isoformat()
        )
    except Exception:
        return 0
    return sum(1 for row in rows if _is_up_halt_reason(row.get("reason_code")))


class HaltResumeTracker:
    """Per-process halt/resume state for hunter scoring and entry gating."""

    def __init__(self) -> None:
        self._prev_halted: set[str] = set()
        self._states: dict[str, dict[str, Any]] = {}
        self._last_change_pct: dict[str, float] = {}

    def note_candidate_momentum(self, ticker: str, change_pct: float | None) -> None:
        if change_pct is not None:
            self._last_change_pct[str(ticker).upper()] = float(change_pct)

    def sync_halts(self, halted: set[str], *, now: float | None = None) -> list[str]:
        """Detect tickers that left the halted set since the last scan."""
        now = now or time.time()
        halted_u = {str(t).upper() for t in halted if t}
        resumed = sorted(self._prev_halted - halted_u)
        newly_halted = halted_u - self._prev_halted
        for ticker in newly_halted:
            change = self._last_change_pct.get(ticker)
            was_up = change is not None and change > 0
            state = self._states.setdefault(ticker, {})
            state["entering_up_halt"] = was_up
        for ticker in resumed:
            self._on_resume(ticker, now=now)
        self._prev_halted = halted_u
        return resumed

    def _on_resume(self, ticker: str, *, now: float) -> None:
        ticker = ticker.upper()
        config = DEFAULT_CONFIG
        cooldown = float(config.get("resume_cooldown_seconds", 60.0))
        state = self._states.setdefault(ticker, {})
        was_up = bool(state.pop("entering_up_halt", False))
        if was_up:
            store_count = _count_up_halts_today(ticker)
            state["resume_halt_count"] = max(
                int(state.get("resume_halt_count") or 0) + 1,
                store_count,
            )
        else:
            state["resume_halt_count"] = int(state.get("resume_halt_count") or 0)
        state["last_resume_at"] = now
        state["resume_cooldown_until"] = now + cooldown
        state["last_was_up_halt"] = was_up
        log.info(
            "[HALT_EXEC] %s resumed (up=%s, halt_count=%s, cooldown %.0fs)",
            ticker,
            was_up,
            state.get("resume_halt_count"),
            cooldown,
        )

    def decorate_suggestion(
        self,
        suggestion: dict[str, Any],
        config: dict[str, Any],
        *,
        candidate: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ticker = str(suggestion.get("ticker") or "").upper()
        state = self._states.get(ticker) or {}
        now = time.time()
        cooldown_until = float(state.get("resume_cooldown_until") or 0.0)
        halt_count = int(state.get("resume_halt_count") or _count_up_halts_today(ticker))

        per_hit = float(config.get("halt_score_bonus_per_hit", 5.0))
        cap = float(config.get("halt_score_bonus_cap", 15.0))
        resume_bonus = 0.0
        if halt_count > 0:
            resume_bonus = min(halt_count * per_hit, cap)

        resume_pending = cooldown_until > now
        out = dict(suggestion)
        if resume_bonus > 0:
            base_score = float(out.get("score") or 0.0)
            out["score"] = round(min(100.0, base_score + resume_bonus), 1)
            reasons = str(out.get("reason") or "")
            out["reason"] = (
                f"{reasons}; +{resume_bonus:.0f} up-halt momentum ({halt_count} halt(s))"
                if reasons
                else f"+{resume_bonus:.0f} up-halt momentum ({halt_count} halt(s))"
            )
        out["resume_halt_count"] = halt_count
        out["resume_bonus"] = round(resume_bonus, 1)
        out["resume_pending"] = resume_pending
        return out

    def resume_entry_ready(
        self,
        ticker: str,
        candles: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> tuple[bool, str]:
        """True when post-resume candle wait is satisfied (or not in cooldown)."""
        from control_plane.agentic.broker import ONE_MINUTE_SECONDS

        ticker = ticker.upper()
        state = self._states.get(ticker) or {}
        now = time.time()
        last_resume = float(state.get("last_resume_at") or 0.0)
        cooldown_until = float(state.get("resume_cooldown_until") or 0.0)
        if last_resume <= 0 or cooldown_until <= last_resume:
            return True, "no resume gate"

        post_resume_closed = False
        for candle in candles:
            ts = candle.get("time") or candle.get("timestamp") or candle.get("ts")
            if ts is None:
                continue
            try:
                candle_epoch = float(ts)
                if candle_epoch > 1e12:
                    candle_epoch /= 1000.0
            except (TypeError, ValueError):
                continue
            if candle_epoch + ONE_MINUTE_SECONDS <= now and candle_epoch >= last_resume - 1.0:
                post_resume_closed = True
                break

        if now < cooldown_until:
            if post_resume_closed:
                return False, f"resume cooldown ({int(cooldown_until - now)}s left)"
            return False, f"waiting for 1m candle after resume ({int(cooldown_until - now)}s left)"
        if not post_resume_closed:
            return False, "waiting for 1m candle after resume"
        return True, "post-resume entry ready"


_tracker: HaltResumeTracker | None = None


def get_halt_resume_tracker() -> HaltResumeTracker:
    global _tracker
    if _tracker is None:
        _tracker = HaltResumeTracker()
    return _tracker


def get_agentic_session_store() -> Any:
    from control_plane.agentic.session_store import get_agentic_session_store as _get

    return _get()


async def reconcile_sessions_for_resumed_tickers(tickers: list[str]) -> None:
    """Immediate broker poll when a halt lifts (short resume windows)."""
    if not tickers:
        return
    want = {str(t).upper() for t in tickers if t}
    store = get_agentic_session_store()
    from control_plane.agentic.reconciliation import reconcile_session_positions

    for session in store.list_sessions_by_status("running"):
        positions = store.list_positions(
            session["id"], states=("pending_open", "open", "pending_close")
        )
        if not any(str(p.get("ticker") or "").upper() in want for p in positions):
            continue
        try:
            repaired = await reconcile_session_positions(session, store)
            if repaired:
                log.info(
                    "[HALT_EXEC] Immediate reconcile session=%s repaired=%d after resume %s",
                    session["id"][:8],
                    repaired,
                    ",".join(sorted(want)[:5]),
                )
        except Exception as exc:
            log.warning("[HALT_EXEC] Immediate reconcile failed: %s", exc)
