"""Async state machine for durable 1% trading sessions."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from control_plane.execution_sources import EXECUTION_SOURCE_ONE_PERCENT_SESSION
from control_plane.one_percent_agent_selection import (
    resolve_focus_symbol_candidates,
    select_with_agent,
)
from control_plane.one_percent_candidates import (
    compute_attempt_brackets,
    find_tradeable_candidates,
)
from control_plane.one_percent_session_store import (
    TERMINAL_STATES,
    OnePercentSessionStore,
    get_one_percent_session_store,
)
from control_plane.trades_pnl_store import get_trades_pnl_store
from utils import order_quantity_from_capital

log = logging.getLogger("backtrading")

POLL_INTERVAL_SEC = 2.0
SNAPSHOT_EVERY_N = 3
ORDER_OPEN_TIMEOUT_SEC = 120.0
# Soft blacklist window for symbols that lost money (same trading day / session).
LOSS_BLACKLIST_HOURS = 24.0


def _ticker_root(symbol: str | None) -> str:
    text = str(symbol or "").strip().upper()
    if not text:
        return ""
    return text.split(".", 1)[0].split("-", 1)[0]


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _threshold_hit(
    *,
    current: float,
    entry_price: float,
    pnl_amount: float,
    take_profit_price: float,
    stop_loss_price: float,
) -> str | None:
    """Return take_profit / stop_loss when live price or PnL crossed attempt brackets."""
    if current <= 0:
        return None
    tp = float(take_profit_price or 0)
    sl = float(stop_loss_price or 0)
    if tp > 0 and current >= tp * 0.999:
        return "take_profit"
    if sl > 0 and current <= sl * 1.001:
        return "stop_loss"
    # Dollar-band fallback from entry↔bracket prices when quantity-based PnL is available.
    if entry_price > 0 and tp > entry_price and pnl_amount >= (tp - entry_price) * 0.999:
        # only meaningful when qty≈1; keep price checks primary
        pass
    return None


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_float(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value


def _row_position_id(row: dict[str, Any] | None) -> str:
    if not isinstance(row, dict):
        return ""
    return str(
        row.get("positionID")
        or row.get("positionId")
        or row.get("PositionID")
        or ""
    )


def _row_order_id(row: dict[str, Any] | None) -> str:
    if not isinstance(row, dict):
        return ""
    return str(row.get("orderID") or row.get("orderId") or row.get("OrderID") or "")


def _row_instrument_id(row: dict[str, Any] | None) -> str:
    if not isinstance(row, dict):
        return ""
    return str(
        row.get("instrumentID")
        or row.get("instrumentId")
        or row.get("InstrumentID")
        or ""
    )


def _position_buy_price(position: dict[str, Any] | None) -> float | None:
    """Actual fill / average open from an eToro position row (never mark/LTP)."""
    if not isinstance(position, dict):
        return None
    for key in (
        "openRate",
        "OpenRate",
        "open_rate",
        "averageprice",
        "averagePrice",
        "AverageOpenRate",
    ):
        value = _as_float(position.get(key))
        if value is not None and value > 0:
            return value
    return None


def _position_unrealized(position: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(position, dict):
        return None
    raw = position.get("unrealizedPnL") or position.get("UnrealizedPnL")
    return raw if isinstance(raw, dict) else None


def _position_mark_price(position: dict[str, Any] | None, *, fallback: float = 0.0) -> float:
    """eToro live mark lives on unrealizedPnL.closeRate (not openRate)."""
    if not isinstance(position, dict):
        return float(fallback or 0)
    unrealized = _position_unrealized(position)
    if unrealized:
        for key in ("closeRate", "CloseRate"):
            value = _as_float(unrealized.get(key))
            if value is not None and value > 0:
                return value
    for key in ("lastRate", "currentRate", "CurrentRate"):
        value = _as_float(position.get(key))
        if value is not None and value > 0:
            return value
    return float(fallback or 0)


def _position_broker_pnl(position: dict[str, Any] | None) -> float | None:
    unrealized = _position_unrealized(position)
    if not unrealized:
        return None
    return _as_float(unrealized.get("pnL") if "pnL" in unrealized else unrealized.get("PnL"))


def _match_open_position(
    positions: list[Any],
    *,
    position_id: str | None,
    order_id: str | None,
    symboltoken: str | None,
) -> tuple[dict[str, Any] | None, str]:
    """Match by positionID first, then opening orderID. Instrument is last-resort only."""
    rows = [row for row in positions if isinstance(row, dict)]
    if position_id:
        for row in rows:
            if _row_position_id(row) == str(position_id):
                return row, "position_id"
    if order_id:
        for row in rows:
            if _row_order_id(row) == str(order_id):
                return row, "order_id"
    # Never instrument-match when we already have a bound position or order — avoids
    # picking an unrelated open of the same symbol.
    if not position_id and not order_id and symboltoken:
        token = str(symboltoken)
        for row in rows:
            if _row_instrument_id(row) == token:
                return row, "instrument_id"
    return None, "none"


def _fill_from_order_lookup(
    lookup: dict[str, Any] | None,
    *,
    preferred_position_id: str | None = None,
) -> dict[str, Any]:
    """Extract position id / open avgPrice / closed state from orders:lookup."""
    result: dict[str, Any] = {
        "position_id": None,
        "buy": None,
        "units": None,
        "state": None,
        "execution": None,
    }
    if not isinstance(lookup, dict):
        return result

    executions = lookup.get("positionExecutions") or []
    chosen: dict[str, Any] | None = None
    if preferred_position_id:
        for execution in executions:
            if not isinstance(execution, dict):
                continue
            if str(execution.get("positionId") or execution.get("positionID") or "") == str(
                preferred_position_id
            ):
                chosen = execution
                break
    if chosen is None:
        for execution in executions:
            if isinstance(execution, dict):
                chosen = execution
                break

    if chosen:
        result["execution"] = chosen
        result["position_id"] = str(
            chosen.get("positionId") or chosen.get("positionID") or ""
        ) or None
        result["state"] = str(chosen.get("state") or "").lower() or None
        result["units"] = _as_float(chosen.get("remainingUnits") or chosen.get("units"))
        opening = chosen.get("openingData") if isinstance(chosen.get("openingData"), dict) else {}
        buy = _as_float(opening.get("avgPrice"))
        if buy is None:
            buy = _position_buy_price(chosen)
        result["buy"] = buy
        if result["units"] is None:
            result["units"] = _as_float(opening.get("units"))

    if result["position_id"] is None:
        for position in lookup.get("positions") or []:
            if not isinstance(position, dict):
                continue
            pid = _row_position_id(position)
            if not pid:
                continue
            if preferred_position_id and pid != str(preferred_position_id):
                continue
            result["position_id"] = pid
            buy = _position_buy_price(position) or _as_float(position.get("rate"))
            if buy is not None:
                result["buy"] = buy
            result["units"] = _as_float(position.get("units") or position.get("Units"))
            if position.get("isOpen") is False:
                result["state"] = "closed"
            break

    return result


class OnePercentSessionEngine:
    def __init__(self, store: OnePercentSessionStore | None = None):
        self.store = store or get_one_percent_session_store()
        self._tasks: dict[str, asyncio.Task] = {}
        self._stop_flags: set[str] = set()
        self._close_flags: set[str] = set()
        self._lock = asyncio.Lock()

    async def startup(self) -> None:
        for session in self.store.list_active_sessions():
            self._ensure_runner(session["id"])

    async def shutdown(self) -> None:
        for session_id in list(self._tasks):
            self._stop_flags.add(session_id)
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._stop_flags.clear()
        self._close_flags.clear()

    def _ensure_runner(self, session_id: str) -> None:
        task = self._tasks.get(session_id)
        if task and not task.done():
            return
        self._stop_flags.discard(session_id)
        self._close_flags.discard(session_id)
        self._tasks[session_id] = asyncio.create_task(
            self._run_session(session_id),
            name=f"one-percent-session-{session_id}",
        )

    async def create_and_start(
        self,
        *,
        account_env: str = "demo",
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = self.store.create_session(account_env=account_env, config=config)
        self._ensure_runner(session["id"])
        return self.store.get_session_detail(session["id"]) or session

    async def stop_session(self, session_id: str, reason: str = "Stopped by user") -> dict[str, Any] | None:
        session = self.store.get_session(session_id)
        if not session:
            return None
        self._stop_flags.add(session_id)
        if session["state"] not in TERMINAL_STATES:
            self.store.set_state(
                session_id,
                "stopped",
                reason=reason,
                extra={
                    "active_order_id": None,
                    "active_position_id": None,
                    "active_execution_id": None,
                },
            )
            self.store.append_event(
                session_id,
                "session_finished",
                state="stopped",
                payload={
                    "outcome": "stopped",
                    "reason": reason,
                    "cumulative_pnl": session.get("cumulative_pnl") or 0,
                    "target_dollars": session.get("target_dollars"),
                    "attempt_count": session.get("attempt_count") or 0,
                },
            )
        task = self._tasks.get(session_id)
        if task and not task.done():
            task.cancel()
        return self.store.get_session_detail(session_id)

    async def request_close_position(
        self,
        session_id: str,
        *,
        reason: str = "Manual close",
    ) -> dict[str, Any] | None:
        """Market-close the active eToro position and let the monitor settle P&L."""
        session = self.store.get_session(session_id)
        if not session:
            return None
        if session.get("state") != "monitoring":
            raise ValueError("Session is not monitoring an open position")
        position_id = str(session.get("active_position_id") or "").strip()
        if not position_id and not session.get("active_order_id"):
            raise ValueError("No active position to close")

        self._close_flags.add(session_id)
        self.store.append_event(
            session_id,
            "manual_close_requested",
            state="monitoring",
            payload={
                "reason": reason,
                "position_id": position_id or None,
                "order_id": session.get("active_order_id"),
                "symbol": session.get("active_symbol"),
            },
        )

        # Close immediately so the UI action does not depend on the next poll tick.
        if position_id:
            env = "live" if str(session.get("account_env") or "").lower() == "live" else "demo"
            attempt_id = session.get("active_attempt_id")
            attempt = self.store.get_attempt(attempt_id) if attempt_id else None
            quantity = float((attempt or {}).get("quantity") or 0) if attempt else 0.0
            token = str((attempt or {}).get("symboltoken") or "") if attempt else ""
            instrument_id = None
            if token:
                try:
                    instrument_id = int(token)
                except (TypeError, ValueError):
                    instrument_id = None
            try:
                from brokers.etoro.order_client import EtoroV2BracketOrderClient

                client = EtoroV2BracketOrderClient(account_env=env)
                client.generate_session()
                await client.aclose_position(
                    position_id,
                    units=float(quantity) if quantity and quantity > 0 else None,
                    instrument_id=instrument_id,
                )
                log.info(
                    "[1PC] manual_close broker ok session=%s position=%s",
                    session_id,
                    position_id,
                )
            except Exception as exc:
                # Flag stays set — monitor loop retries / settles from portfolio.
                log.warning(
                    "[1PC] manual_close broker error session=%s position=%s err=%s",
                    session_id,
                    position_id,
                    exc,
                )
                self.store.append_event(
                    session_id,
                    "force_close_error",
                    state="monitoring",
                    payload={"error": str(exc), "position_id": position_id, "close_reason": "manual_close"},
                )

        return self.store.get_session_detail(session_id)

    def _loss_blacklist(self, session_id: str) -> set[str]:
        """Symbols that lost money recently — skip for a while on later attempts."""
        blocked: set[str] = set()
        now = datetime.now(timezone.utc)
        for attempt in self.store.list_attempts(session_id):
            if str(attempt.get("outcome") or "").lower() != "loss":
                continue
            finished = _parse_iso(attempt.get("finished_at")) or _parse_iso(attempt.get("created_at"))
            if finished is not None:
                age_h = (now - finished.astimezone(timezone.utc)).total_seconds() / 3600.0
                if age_h > LOSS_BLACKLIST_HOURS:
                    continue
            symbol = str(attempt.get("symbol") or attempt.get("tradingsymbol") or "").upper()
            root = _ticker_root(symbol)
            if symbol:
                blocked.add(symbol)
            if root:
                blocked.add(root)
        return blocked

    async def check_eligibility(
        self,
        *,
        account_env: str = "demo",
        capital: float = 1000.0,
    ) -> dict[str, Any]:
        env = "live" if (account_env or "demo").lower() == "live" else "demo"
        active = self.store.get_active_for_day(account_env=env)
        available_cash: float | None = None
        balance_error: str | None = None
        try:
            from brokers.etoro.order_client import EtoroV2BracketOrderClient

            client = EtoroV2BracketOrderClient(account_env=env)
            client.generate_session()
            available_cash = float(await client.aget_available_cash())
        except Exception as exc:
            balance_error = str(exc)
            log.warning("[1PC] eligibility balance check failed env=%s: %s", env, exc)

        required = float(capital or 1000.0)
        sufficient = available_cash is not None and available_cash >= required
        can_start = sufficient and active is None and not balance_error
        reasons: list[str] = []
        if balance_error:
            reasons.append(f"Could not verify eToro balance: {balance_error}")
        elif available_cash is None:
            reasons.append("Available cash unavailable")
        elif not sufficient:
            reasons.append(
                f"Need at least ${required:.2f}; available ${available_cash:.2f}"
            )
        if active:
            reasons.append("An active 1% session already exists for today")
        return {
            "account_env": env,
            "required_capital": required,
            "available_cash": available_cash,
            "sufficient": bool(sufficient),
            "active_session_id": active["id"] if active else None,
            "can_start": can_start,
            "reasons": reasons,
            "checked_at": _now_utc(),
        }

    async def _run_session(self, session_id: str) -> None:
        try:
            while True:
                if session_id in self._stop_flags:
                    return
                session = self.store.get_session(session_id)
                if not session or session["state"] in TERMINAL_STATES:
                    return
                state = session["state"]
                if state in {"created", "verifying_balance"}:
                    await self._phase_verify_balance(session)
                elif state in {"screening", "selecting", "configuring", "placing", "evaluating"}:
                    await self._phase_attempt_cycle(session)
                elif state == "monitoring":
                    await self._phase_monitor(session)
                else:
                    log.warning("[1PC] unknown state=%s session=%s", state, session_id)
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("[1PC] session runner crashed session=%s: %s", session_id, exc, exc_info=True)
            self.store.set_state(session_id, "stopped", reason=f"Engine error: {exc}")
            self.store.append_event(
                session_id,
                "session_finished",
                state="stopped",
                payload={"outcome": "error", "reason": str(exc)},
            )
        finally:
            self._tasks.pop(session_id, None)

    async def _phase_verify_balance(self, session: dict[str, Any]) -> None:
        session_id = session["id"]
        config = session.get("config") or {}
        capital = float(config.get("capital") or 1000)
        self.store.set_state(session_id, "verifying_balance")
        self.store.append_event(
            session_id,
            "verifying_balance",
            state="verifying_balance",
            payload={"required_capital": capital, "account_env": session["account_env"]},
        )
        eligibility = await self.check_eligibility(
            account_env=session["account_env"],
            capital=capital,
        )
        if eligibility.get("active_session_id") not in {None, session_id}:
            await self.stop_session(session_id, "Another active session already exists")
            return
        if not eligibility.get("sufficient"):
            reason = "; ".join(eligibility.get("reasons") or ["Insufficient funds"])
            self.store.set_state(session_id, "stopped", reason=reason)
            self.store.append_event(
                session_id,
                "session_finished",
                state="stopped",
                payload={
                    "outcome": "ineligible",
                    "reason": reason,
                    "eligibility": eligibility,
                },
            )
            return
        self.store.append_event(
            session_id,
            "balance_verified",
            state="verifying_balance",
            payload=eligibility,
        )
        self.store.set_state(session_id, "screening")

    async def _phase_attempt_cycle(self, session: dict[str, Any]) -> None:
        session_id = session["id"]
        config = session.get("config") or {}
        max_attempts = int(session.get("max_attempts") or config.get("max_attempts") or 3)
        attempt_count = int(session.get("attempt_count") or 0)
        next_attempt = attempt_count + 1
        if next_attempt > max_attempts:
            await self._finish_session(
                session,
                outcome="max_attempts",
                reason=f"Reached max attempts ({max_attempts})",
            )
            return

        # Screening / focus symbols — blacklist only symbols that incurred a loss.
        self.store.set_state(session_id, "screening")
        exclude = self._loss_blacklist(session_id)
        focus_symbols = [
            str(s).strip().upper()
            for s in (config.get("focus_symbols") or [])
            if str(s).strip()
        ]
        selection_mode = str(config.get("selection_mode") or "deterministic").strip().lower()
        if focus_symbols:
            selection_mode = "agent"

        self.store.append_event(
            session_id,
            "screening_started",
            state="screening",
            payload={
                "attempt_number": next_attempt,
                "max_attempts": max_attempts,
                "exclude_symbols": sorted(s for s in exclude if s),
                "selection_mode": selection_mode,
                "focus_symbols": focus_symbols,
            },
        )
        try:
            if focus_symbols:
                screened = await resolve_focus_symbol_candidates(
                    focus_symbols,
                    account_env=session["account_env"],
                    exclude_symbols=exclude,
                )
            else:
                screened = await find_tradeable_candidates(
                    account_env=session["account_env"],
                    exclude_symbols=exclude,
                    screener_mode=str(config.get("screener_mode") or "auto"),
                    query_keys=list(config.get("query_keys") or []),
                    screener_ids=list(config.get("screener_ids") or []),
                    min_score=float(config.get("min_score") or 0),
                    limit=12,
                )
        except Exception as exc:
            self.store.append_event(
                session_id,
                "screening_failed",
                state="screening",
                payload={"error": str(exc), "attempt_number": next_attempt},
            )
            await self._finish_session(session, outcome="screening_failed", reason=str(exc))
            return

        candidates = screened.get("candidates") or []
        self.store.append_event(
            session_id,
            "candidates_found",
            state="screening",
            payload={
                "attempt_number": next_attempt,
                "market_phase": screened.get("market_phase"),
                "screener_mode": screened.get("screener_mode"),
                "query_key": screened.get("query_key"),
                "query_keys": screened.get("query_keys"),
                "screener_ids": screened.get("screener_ids"),
                "query_name": screened.get("query_name"),
                "query_names": screened.get("query_names"),
                "min_score": screened.get("min_score"),
                "sources": screened.get("sources"),
                "selection_mode": selection_mode,
                "focus_symbols": focus_symbols,
                "total_found": screened.get("total_found"),
                "candidates": [
                    {
                        "symbol": c.get("symbol"),
                        "name": c.get("instrument_name") or c.get("name"),
                        "close": c.get("close"),
                        "score": c.get("score"),
                        "change_pct": c.get("change_pct"),
                        "logo50x50": c.get("logo50x50"),
                    }
                    for c in candidates[:8]
                ],
                "unresolved": screened.get("unresolved") or [],
            },
        )
        if not candidates:
            await self._finish_session(
                session,
                outcome="no_candidates",
                reason=(
                    "No eToro-tradeable focus symbols found"
                    if focus_symbols
                    else "No eToro-tradeable candidates found"
                ),
            )
            return

        # Select candidate (algo top score vs AI agent research)
        selected: dict[str, Any] | None = None
        reasoning_bullets: list[str] = []
        selection_meta: dict[str, Any] = {
            "selection_mode": selection_mode,
            "decision_source": "deterministic",
            "confidence": None,
            "place": True,
            "sources": [],
        }

        if selection_mode in {"agent", "hybrid"}:
            self.store.set_state(session_id, "selecting")
            decision = await select_with_agent(
                session_id=session_id,
                store=self.store,
                session=session,
                candidates=candidates[:6],
                require_place_gate=bool(focus_symbols),
            )
            selection_meta.update({
                "decision_source": decision.get("decision_source") or "agent",
                "confidence": decision.get("confidence"),
                "place": bool(decision.get("place")),
                "sources": decision.get("sources") or [],
            })
            reasoning_bullets = list(decision.get("reasoning_bullets") or [])[:4]
            selected = decision.get("selected") if isinstance(decision.get("selected"), dict) else None
            if not selected and selection_mode == "hybrid" and not focus_symbols:
                selected = candidates[0]
                selection_meta["decision_source"] = "hybrid_fallback"
                selection_meta["place"] = True
                if not reasoning_bullets:
                    reasoning_bullets = [
                        "Hybrid fallback: agent did not place — using highest screener score.",
                    ]
            if not selected or not selection_meta.get("place"):
                declined_symbol = str(
                    (decision.get("symbol") if isinstance(decision, dict) else None)
                    or (candidates[0].get("symbol") if candidates else "")
                    or "Selection"
                )
                self.store.append_event(
                    session_id,
                    "agent_no_place",
                    state="selecting",
                    payload={
                        "attempt_number": next_attempt,
                        "symbol": declined_symbol,
                        "confidence": selection_meta.get("confidence"),
                        "reasoning_bullets": reasoning_bullets,
                        "sources": selection_meta.get("sources"),
                        "focus_symbols": focus_symbols,
                    },
                )
                await self._finish_session(
                    session,
                    outcome="agent_no_place",
                    reason=(
                        f"AI agent declined to place "
                        f"(confidence {selection_meta.get('confidence')})"
                    ),
                )
                return
        else:
            selected = candidates[0]
            reasoning_bullets = [
                "Highest deterministic momentum/liquidity score among eToro-available names.",
            ]
            selection_meta["sources"] = [{"label": "Screener", "detail": screened.get("query_name") or "rank"}]

        assert selected is not None
        self.store.set_state(session_id, "selecting", extra={"active_symbol": selected.get("symbol")})
        self.store.append_event(
            session_id,
            "stock_selected",
            state="selecting",
            payload={
                "attempt_number": next_attempt,
                "max_attempts": max_attempts,
                "symbol": selected.get("symbol"),
                "name": selected.get("instrument_name") or selected.get("name"),
                "symboltoken": selected.get("symboltoken"),
                "current_price": selected.get("close"),
                "score": selected.get("score"),
                "change_pct": selected.get("change_pct"),
                "logo35x35": selected.get("logo35x35"),
                "logo50x50": selected.get("logo50x50"),
                "logo150x150": selected.get("logo150x150"),
                "query_name": screened.get("query_name"),
                "selection_mode": selection_mode,
                "decision_source": selection_meta.get("decision_source"),
                "confidence": selection_meta.get("confidence"),
                "reasoning_bullets": reasoning_bullets,
                "sources": selection_meta.get("sources"),
                "reason": reasoning_bullets[0] if reasoning_bullets else "Selected",
            },
        )

        entry_price = float(selected.get("close") or 0)
        capital = float(config.get("capital") or 1000)
        brackets = compute_attempt_brackets(
            entry_price=entry_price,
            capital=capital,
            take_profit_pct=float(config.get("take_profit_pct") or 1.5),
            stop_loss_pct=float(config.get("stop_loss_pct") or 2.0),
            cumulative_pnl=float(session.get("cumulative_pnl") or 0),
            target_dollars=float(session.get("target_dollars") or config.get("target_dollars") or 10),
        )

        self.store.set_state(session_id, "configuring")
        attempt = self.store.create_attempt(
            session_id,
            attempt_number=next_attempt,
            symbol=selected.get("symbol"),
            tradingsymbol=selected.get("tradingsymbol") or selected.get("symbol"),
            symboltoken=selected.get("symboltoken"),
            exchange="ETORO",
            candidate=selected,
            capital=capital,
            entry_price=entry_price,
            take_profit_pct=brackets["take_profit_pct"],
            take_profit_price=brackets["take_profit_price"],
            stop_loss_pct=brackets["stop_loss_pct"],
            stop_loss_price=brackets["stop_loss_price"],
            recovery_amount=brackets["recovery_amount"],
        )
        self.store.append_event(
            session_id,
            "order_configured",
            state="configuring",
            payload={
                "attempt_id": attempt["id"],
                "attempt_number": next_attempt,
                "max_attempts": max_attempts,
                "symbol": attempt.get("symbol"),
                "symboltoken": attempt.get("symboltoken") or selected.get("symboltoken"),
                "name": selected.get("instrument_name") or selected.get("name"),
                "capital": capital,
                "entry_price": entry_price,
                "current_price": entry_price,
                "take_profit_pct": brackets["take_profit_pct"],
                "take_profit_price": brackets["take_profit_price"],
                "stop_loss_pct": brackets["stop_loss_pct"],
                "stop_loss_price": brackets["stop_loss_price"],
                "recovery_amount": brackets["recovery_amount"],
                "remaining_target": brackets["remaining_target"],
                "logo50x50": selected.get("logo50x50"),
            },
        )

        await self._place_order(session, attempt, selected)

    async def _place_order(
        self,
        session: dict[str, Any],
        attempt: dict[str, Any],
        selected: dict[str, Any],
    ) -> None:
        session_id = session["id"]
        config = session.get("config") or {}
        env = session["account_env"]
        capital = float(attempt.get("capital") or config.get("capital") or 1000)
        entry_price = float(attempt.get("entry_price") or selected.get("close") or 0)
        symbol = str(attempt.get("symbol") or "")
        token = str(attempt.get("symboltoken") or "")

        self.store.set_state(session_id, "placing")
        quantity = order_quantity_from_capital(capital, entry_price, allow_partial=True)
        if quantity <= 0:
            await self._finish_session(
                session,
                outcome="sizing_failed",
                reason=f"Capital ${capital:.2f} too small for {symbol} at ${entry_price:.2f}",
            )
            return

        from brokers.etoro.order_client import EtoroV2BracketOrderClient

        try:
            client = EtoroV2BracketOrderClient(account_env=env)
            client.generate_session()
            available_cash = float(await client.aget_available_cash())
            deploy_capital = min(capital, available_cash)
            quantity = order_quantity_from_capital(deploy_capital, entry_price, allow_partial=True)
            if quantity <= 0 or deploy_capital <= 0:
                raise RuntimeError(
                    f"Insufficient funds (available ${available_cash:.2f})"
                )
            buy_result = await client.abuy_with_take_profit_stop_loss(
                ltp=entry_price,
                available_capital=deploy_capital,
                symbol=symbol,
                token=token,
                exchange="ETORO",
                take_profit_rate=attempt.get("take_profit_price"),
                stop_loss_rate=attempt.get("stop_loss_price"),
                instrument_class="equity",
                quantity=quantity,
            )
        except Exception as exc:
            self.store.append_event(
                session_id,
                "order_failed",
                state="placing",
                payload={
                    "attempt_id": attempt["id"],
                    "symbol": symbol,
                    "error": str(exc),
                },
            )
            await self._finish_session(session, outcome="order_failed", reason=str(exc))
            return

        order_id = str((buy_result or {}).get("order_id") or "")
        if not order_id:
            error = (buy_result or {}).get("error_message") or "eToro did not return an order id"
            self.store.append_event(
                session_id,
                "order_failed",
                state="placing",
                payload={"attempt_id": attempt["id"], "symbol": symbol, "error": error},
            )
            await self._finish_session(session, outcome="order_failed", reason=error)
            return

        stop_loss_price = (buy_result or {}).get("stop_loss_rate") or attempt.get("stop_loss_price")
        self.store.update_attempt(
            attempt["id"],
            {
                "order_id": order_id,
                "quantity": quantity,
                "capital": deploy_capital,
                "stop_loss_price": stop_loss_price,
            },
        )
        self.store.update_session(
            session_id,
            {
                "active_order_id": order_id,
                "active_attempt_id": attempt["id"],
                "active_symbol": symbol,
            },
        )

        try:
            get_trades_pnl_store().record_entry(
                execution_id=f"1pc-{attempt['id']}",
                order_id=order_id,
                source=EXECUTION_SOURCE_ONE_PERCENT_SESSION,
                broker="etoro",
                account_env=env,
                symbol=symbol,
                tradingsymbol=symbol,
                symboltoken=token,
                exchange="ETORO",
                side="buy",
                quantity=quantity,
                capital=deploy_capital,
                entry_price=entry_price,
                take_profit_price=attempt.get("take_profit_price"),
                stop_loss_price=stop_loss_price,
                session_id=session_id,
                attempt_id=attempt["id"],
            )
        except Exception as exc:
            log.debug("[1PC] trades_pnl entry skipped: %s", exc)

        self.store.append_event(
            session_id,
            "order_placed",
            state="placing",
            payload={
                "attempt_id": attempt["id"],
                "attempt_number": attempt.get("attempt_number"),
                "max_attempts": session.get("max_attempts"),
                "symbol": symbol,
                "symboltoken": attempt.get("symboltoken") or selected.get("symboltoken") or token,
                "name": selected.get("instrument_name") or selected.get("name"),
                "order_id": order_id,
                "quantity": quantity,
                "capital": deploy_capital,
                "entry_price": entry_price,
                "current_price": entry_price,
                "take_profit_pct": attempt.get("take_profit_pct"),
                "take_profit_price": attempt.get("take_profit_price"),
                "stop_loss_pct": attempt.get("stop_loss_pct"),
                "stop_loss_price": stop_loss_price,
                "logo50x50": selected.get("logo50x50"),
                "estimated_pnl": 0,
                "estimated_pnl_pct": 0,
            },
        )
        self.store.set_state(session_id, "monitoring")

    async def _phase_monitor(self, session: dict[str, Any]) -> None:
        session_id = session["id"]
        attempt_id = session.get("active_attempt_id")
        if not attempt_id:
            self.store.set_state(session_id, "evaluating")
            return
        attempt = self.store.get_attempt(attempt_id)
        if not attempt:
            self.store.set_state(session_id, "evaluating")
            return

        env = session["account_env"]
        order_id = attempt.get("order_id") or session.get("active_order_id")
        position_id = attempt.get("position_id") or session.get("active_position_id")
        entry_price = float(attempt.get("entry_price") or 0)
        quantity = float(attempt.get("quantity") or 0)
        capital = float(attempt.get("capital") or 0)
        candidate = attempt.get("candidate") or {}

        from brokers.etoro.order_client import EtoroV2BracketOrderClient

        client = EtoroV2BracketOrderClient(account_env=env)
        client.generate_session()

        ticks = 0
        opened_at = datetime.now(timezone.utc)
        last_mark: float | None = None
        last_broker_pnl: float | None = None
        last_matched: dict[str, Any] | None = None
        logged_match = False

        while True:
            if session_id in self._stop_flags:
                return
            session = self.store.get_session(session_id) or session
            if session["state"] in TERMINAL_STATES:
                return

            try:
                portfolio = await client.aget_client_portfolio()
            except Exception as exc:
                self.store.append_event(
                    session_id,
                    "monitor_error",
                    state="monitoring",
                    payload={"error": str(exc), "attempt_id": attempt_id},
                )
                await asyncio.sleep(POLL_INTERVAL_SEC)
                continue

            positions = [row for row in (portfolio.get("positions") or []) if isinstance(row, dict)]
            matched, match_method = _match_open_position(
                positions,
                position_id=str(position_id) if position_id else None,
                order_id=str(order_id) if order_id else None,
                symboltoken=str(attempt.get("symboltoken") or "") or None,
            )

            # Bind position id / openRate from orders:lookup when portfolio has no row yet.
            if matched is None and order_id and not position_id:
                try:
                    lookup = await client.aget_order_status(order_id)
                    log.info(
                        "[1PC] etoro_order_lookup waiting_fill session=%s attempt=%s order_id=%s json=%s",
                        session_id,
                        attempt_id,
                        order_id,
                        json.dumps(lookup, default=str),
                    )
                    fill = _fill_from_order_lookup(lookup)
                    if fill.get("position_id"):
                        position_id = fill["position_id"]
                        self.store.update_attempt(attempt_id, {"position_id": position_id})
                        self.store.update_session(session_id, {"active_position_id": position_id})
                        attempt = {**attempt, "position_id": position_id}
                    if fill.get("buy") and float(fill["buy"]) > 0:
                        open_rate = float(fill["buy"])
                        if abs(float(attempt.get("entry_price") or 0) - open_rate) > 1e-9:
                            entry_price = open_rate
                            self.store.update_attempt(attempt_id, {"entry_price": open_rate})
                            attempt = {**attempt, "entry_price": open_rate}
                    matched, match_method = _match_open_position(
                        positions,
                        position_id=str(position_id) if position_id else None,
                        order_id=str(order_id) if order_id else None,
                        symboltoken=None,
                    )
                except Exception as exc:
                    log.warning(
                        "[1PC] etoro_order_lookup waiting_fill failed session=%s order_id=%s err=%s",
                        session_id,
                        order_id,
                        exc,
                    )

            if matched:
                pid = _row_position_id(matched)
                open_rate = _position_buy_price(matched) or 0.0
                current = _position_mark_price(matched, fallback=0.0)
                if current <= 0:
                    current = open_rate or entry_price
                broker_pnl = _position_broker_pnl(matched)
                units = float(matched.get("units") or matched.get("Units") or quantity or 0)
                last_matched = matched
                last_mark = current if current > 0 else last_mark
                last_broker_pnl = broker_pnl if broker_pnl is not None else last_broker_pnl

                if not logged_match:
                    logged_match = True
                    log.info(
                        "[1PC] etoro_position_matched session=%s attempt=%s method=%s "
                        "want_position_id=%s want_order_id=%s openRate=%s mark=%s broker_pnl=%s json=%s",
                        session_id,
                        attempt_id,
                        match_method,
                        position_id,
                        order_id,
                        open_rate,
                        current,
                        broker_pnl,
                        json.dumps(matched, default=str),
                    )

                attempt_updates: dict[str, Any] = {}
                if pid and pid != str(position_id or ""):
                    position_id = pid
                    attempt_updates["position_id"] = pid
                    self.store.update_session(session_id, {"active_position_id": pid})
                fill_just_learned = False
                if open_rate > 0:
                    prior_entry = float(attempt.get("entry_price") or entry_price or 0)
                    if abs(prior_entry - open_rate) > 1e-9 or prior_entry <= 0:
                        fill_just_learned = True
                        attempt_updates["entry_price"] = open_rate
                    entry_price = open_rate
                if units > 0 and abs(units - float(quantity or 0)) > 1e-9:
                    quantity = units
                    attempt_updates["quantity"] = units
                if attempt_updates:
                    self.store.update_attempt(attempt_id, attempt_updates)
                    attempt = {**attempt, **attempt_updates}
                    try:
                        if "entry_price" in attempt_updates:
                            get_trades_pnl_store().record_entry(
                                execution_id=f"1pc-{attempt_id}",
                                order_id=str(order_id or ""),
                                source=EXECUTION_SOURCE_ONE_PERCENT_SESSION,
                                broker="etoro",
                                account_env=env,
                                symbol=str(attempt.get("symbol") or ""),
                                tradingsymbol=str(attempt.get("symbol") or ""),
                                symboltoken=str(attempt.get("symboltoken") or ""),
                                exchange="ETORO",
                                side="buy",
                                quantity=quantity,
                                capital=capital,
                                entry_price=entry_price,
                                take_profit_price=attempt.get("take_profit_price"),
                                stop_loss_price=attempt.get("stop_loss_price"),
                                session_id=session_id,
                                attempt_id=attempt_id,
                            )
                    except Exception as exc:
                        log.debug("[1PC] trades_pnl entry refresh skipped: %s", exc)
                if fill_just_learned and open_rate > 0:
                    self.store.append_event(
                        session_id,
                        "entry_filled",
                        state="monitoring",
                        payload={
                            "attempt_id": attempt_id,
                            "attempt_number": attempt.get("attempt_number"),
                            "max_attempts": session.get("max_attempts"),
                            "symbol": attempt.get("symbol"),
                            "symboltoken": attempt.get("symboltoken") or candidate.get("symboltoken"),
                            "name": candidate.get("instrument_name") or candidate.get("name"),
                            "logo50x50": candidate.get("logo50x50"),
                            "order_id": order_id,
                            "position_id": position_id,
                            "match_method": match_method,
                            "buy": open_rate,
                            "entry_price": open_rate,
                            "quantity": quantity,
                            "current_price": current,
                            "take_profit_price": attempt.get("take_profit_price"),
                            "take_profit_pct": attempt.get("take_profit_pct"),
                            "stop_loss_price": attempt.get("stop_loss_price"),
                            "stop_loss_pct": attempt.get("stop_loss_pct"),
                        },
                    )
                if broker_pnl is not None:
                    pnl_amount = float(broker_pnl)
                else:
                    pnl_amount = (current - entry_price) * quantity if entry_price and quantity else 0.0
                pnl_pct = ((current - entry_price) / entry_price * 100.0) if entry_price else 0.0
                cumulative = float(session.get("cumulative_pnl") or 0)
                target = float(session.get("target_dollars") or 0)
                projected = cumulative + pnl_amount
                remaining_to_target = round(target - projected, 2) if target else None
                goal_pct = (
                    round(max(0.0, min(100.0, (projected / target) * 100.0)), 2)
                    if target > 0
                    else None
                )
                tp_pct = float(attempt.get("take_profit_pct") or 0)
                tp_price = float(attempt.get("take_profit_price") or 0)
                tp_pct_complete = None
                remaining_to_tp = None
                if tp_pct > 0:
                    tp_pct_complete = round(max(0.0, min(100.0, (pnl_pct / tp_pct) * 100.0)), 2)
                    target_tp_pnl = (
                        (entry_price * (tp_pct / 100.0) * quantity)
                        if entry_price and quantity
                        else None
                    )
                    if target_tp_pnl is not None:
                        remaining_to_tp = round(target_tp_pnl - pnl_amount, 2)
                elif tp_price > 0 and entry_price > 0 and quantity > 0 and tp_price != entry_price:
                    span = tp_price - entry_price
                    tp_pct_complete = round(
                        max(0.0, min(100.0, ((current - entry_price) / span) * 100.0)),
                        2,
                    )
                    remaining_to_tp = round((tp_price - current) * quantity, 2)
                ticks += 1
                if ticks == 1 or ticks % SNAPSHOT_EVERY_N == 0:
                    self.store.append_event(
                        session_id,
                        "position_snapshot",
                        state="monitoring",
                        payload={
                            "attempt_id": attempt_id,
                            "attempt_number": attempt.get("attempt_number"),
                            "max_attempts": session.get("max_attempts"),
                            "symbol": attempt.get("symbol"),
                            "symboltoken": attempt.get("symboltoken") or candidate.get("symboltoken"),
                            "name": candidate.get("instrument_name") or candidate.get("name"),
                            "logo50x50": candidate.get("logo50x50"),
                            "order_id": order_id,
                            "position_id": position_id,
                            "match_method": match_method,
                            "entry_price": entry_price,
                            "buy": entry_price,
                            "current_price": current,
                            "take_profit_price": attempt.get("take_profit_price"),
                            "take_profit_pct": attempt.get("take_profit_pct"),
                            "stop_loss_price": attempt.get("stop_loss_price"),
                            "stop_loss_pct": attempt.get("stop_loss_pct"),
                            "quantity": quantity,
                            "estimated_pnl": round(pnl_amount, 2),
                            "estimated_pnl_pct": round(pnl_pct, 4),
                            "broker_pnl": broker_pnl,
                            "cumulative_pnl": round(cumulative, 2),
                            "target_dollars": target,
                            "remaining_to_target": remaining_to_target,
                            "goal_pct_complete": goal_pct,
                            "tp_pct_complete": tp_pct_complete,
                            "remaining_to_tp": remaining_to_tp,
                        },
                    )

                # Force-close when eToro brackets didn't fire but live P/L crossed TP/SL.
                threshold = _threshold_hit(
                    current=float(current or 0),
                    entry_price=float(entry_price or 0),
                    pnl_amount=float(pnl_amount or 0),
                    take_profit_price=float(attempt.get("take_profit_price") or 0),
                    stop_loss_price=float(attempt.get("stop_loss_price") or 0),
                )
                manual_close = session_id in self._close_flags
                if threshold or manual_close:
                    close_why = "manual_close" if manual_close else threshold
                    self._close_flags.discard(session_id)
                    await self._force_close_open_position(
                        session=session,
                        attempt=attempt,
                        client=client,
                        order_id=str(order_id) if order_id else None,
                        position_id=str(position_id) if position_id else None,
                        entry_price=entry_price,
                        quantity=quantity,
                        last_mark=current,
                        last_broker_pnl=broker_pnl if broker_pnl is not None else pnl_amount,
                        last_matched=matched,
                        open_positions=positions,
                        close_reason=str(close_why),
                    )
                    return
            else:
                elapsed = (datetime.now(timezone.utc) - opened_at).total_seconds()
                # orders:lookup can return positionId+openRate before /pnl lists the
                # row. Only treat "missing from portfolio" as a real close after we
                # have actually seen the position open at least once.
                if last_matched is None:
                    if elapsed < ORDER_OPEN_TIMEOUT_SEC:
                        lookup_state = None
                        if order_id:
                            try:
                                lookup = await client.aget_order_status(order_id)
                                fill = _fill_from_order_lookup(
                                    lookup,
                                    preferred_position_id=str(position_id) if position_id else None,
                                )
                                lookup_state = fill.get("state")
                                # Still open (or unknown) at broker — keep waiting for /pnl.
                                if lookup_state and lookup_state != "closed":
                                    log.info(
                                        "[1PC] etoro_waiting_portfolio session=%s attempt=%s "
                                        "order_id=%s position_id=%s lookup_state=%s "
                                        "open_positions=%s elapsed=%.1fs",
                                        session_id,
                                        attempt_id,
                                        order_id,
                                        position_id or fill.get("position_id"),
                                        lookup_state,
                                        len(positions),
                                        elapsed,
                                    )
                                    await asyncio.sleep(POLL_INTERVAL_SEC)
                                    continue
                                # Lookup already says closed without us ever seeing it
                                # in portfolio — unusual; still require a short settle
                                # window so we don't false-close on a flaky first poll.
                                if lookup_state == "closed" and elapsed < 15.0:
                                    log.info(
                                        "[1PC] etoro_lookup_closed_early session=%s attempt=%s "
                                        "order_id=%s elapsed=%.1fs — waiting for portfolio settle",
                                        session_id,
                                        attempt_id,
                                        order_id,
                                        elapsed,
                                    )
                                    await asyncio.sleep(POLL_INTERVAL_SEC)
                                    continue
                            except Exception as exc:
                                log.debug(
                                    "[1PC] waiting_portfolio lookup failed session=%s err=%s",
                                    session_id,
                                    exc,
                                )
                        log.info(
                            "[1PC] etoro_waiting_fill session=%s attempt=%s order_id=%s "
                            "position_id=%s open_positions=%s elapsed=%.1fs",
                            session_id,
                            attempt_id,
                            order_id,
                            position_id,
                            json.dumps(
                                [
                                    {
                                        "positionID": _row_position_id(row),
                                        "orderID": _row_order_id(row),
                                        "instrumentID": _row_instrument_id(row),
                                        "openRate": _position_buy_price(row),
                                        "mark": _position_mark_price(row),
                                    }
                                    for row in positions
                                ],
                                default=str,
                            ),
                            elapsed,
                        )
                        await asyncio.sleep(POLL_INTERVAL_SEC)
                        continue

                    self.store.append_event(
                        session_id,
                        "order_failed",
                        state="monitoring",
                        payload={
                            "attempt_id": attempt_id,
                            "symbol": attempt.get("symbol"),
                            "error": "Order did not open a position in time",
                        },
                    )
                    await self._finish_session(
                        session,
                        outcome="order_timeout",
                        reason="Order did not open a position in time",
                    )
                    return

                await self._close_from_broker(
                    session=session,
                    attempt=attempt,
                    client=client,
                    order_id=str(order_id) if order_id else None,
                    position_id=str(position_id) if position_id else None,
                    entry_price=entry_price,
                    quantity=quantity,
                    last_mark=last_mark,
                    last_broker_pnl=last_broker_pnl,
                    last_matched=last_matched,
                    open_positions=positions,
                )
                return

            await asyncio.sleep(POLL_INTERVAL_SEC)

    async def _force_close_open_position(
        self,
        *,
        session: dict[str, Any],
        attempt: dict[str, Any],
        client: Any,
        order_id: str | None,
        position_id: str | None,
        entry_price: float,
        quantity: float,
        last_mark: float | None,
        last_broker_pnl: float | None,
        last_matched: dict[str, Any] | None,
        open_positions: list[dict[str, Any]],
        close_reason: str,
    ) -> None:
        """Market-close on eToro when brackets didn't fire (or user clicked Close)."""
        session_id = session["id"]
        pid = str(position_id or "").strip()
        token = str(attempt.get("symboltoken") or "") or None
        instrument_id = None
        if token:
            try:
                instrument_id = int(token)
            except (TypeError, ValueError):
                instrument_id = None

        self.store.append_event(
            session_id,
            "force_close_started",
            state="monitoring",
            payload={
                "attempt_id": attempt.get("id"),
                "symbol": attempt.get("symbol"),
                "position_id": pid,
                "order_id": order_id,
                "close_reason": close_reason,
                "last_mark": last_mark,
                "last_broker_pnl": last_broker_pnl,
            },
        )

        if pid:
            try:
                await client.aclose_position(
                    pid,
                    units=float(quantity) if quantity and quantity > 0 else None,
                    instrument_id=instrument_id,
                )
                log.info(
                    "[1PC] force_close ok session=%s position=%s reason=%s",
                    session_id,
                    pid,
                    close_reason,
                )
            except Exception as exc:
                log.warning(
                    "[1PC] force_close broker error session=%s position=%s err=%s — completing from marks",
                    session_id,
                    pid,
                    exc,
                )
                self.store.append_event(
                    session_id,
                    "force_close_error",
                    state="monitoring",
                    payload={"error": str(exc), "position_id": pid, "close_reason": close_reason},
                )

        # Prefer broker history / LTP settlement path; fall back to last mark.
        await self._close_from_broker(
            session=session,
            attempt=attempt,
            client=client,
            order_id=order_id,
            position_id=pid or None,
            entry_price=entry_price,
            quantity=quantity,
            last_mark=last_mark,
            last_broker_pnl=last_broker_pnl,
            last_matched=last_matched,
            open_positions=open_positions,
            forced_close_reason=close_reason,
        )

    async def _close_from_broker(
        self,
        *,
        session: dict[str, Any],
        attempt: dict[str, Any],
        client: Any,
        order_id: str | None,
        position_id: str | None,
        entry_price: float,
        quantity: float,
        last_mark: float | None,
        last_broker_pnl: float | None,
        last_matched: dict[str, Any] | None,
        open_positions: list[dict[str, Any]],
        forced_close_reason: str | None = None,
    ) -> None:
        """Position missing from portfolio — resolve buy/sell from eToro, not screener LTP."""
        session_id = session["id"]
        attempt_id = attempt["id"]
        lookup: dict[str, Any] | None = None
        fill: dict[str, Any] = {}

        log.info(
            "[1PC] etoro_position_missing session=%s attempt=%s position_id=%s order_id=%s "
            "last_mark=%s last_broker_pnl=%s last_matched=%s open_positions=%s",
            session_id,
            attempt_id,
            position_id,
            order_id,
            last_mark,
            last_broker_pnl,
            json.dumps(last_matched, default=str) if last_matched else None,
            json.dumps(
                [
                    {
                        "positionID": _row_position_id(row),
                        "orderID": _row_order_id(row),
                        "instrumentID": _row_instrument_id(row),
                        "openRate": _position_buy_price(row),
                        "mark": _position_mark_price(row),
                    }
                    for row in open_positions
                ],
                default=str,
            ),
        )

        if order_id:
            try:
                lookup = await client.aget_order_status(order_id)
                log.info(
                    "[1PC] etoro_order_lookup on_close session=%s attempt=%s order_id=%s json=%s",
                    session_id,
                    attempt_id,
                    order_id,
                    json.dumps(lookup, default=str),
                )
                fill = _fill_from_order_lookup(lookup, preferred_position_id=position_id)
            except Exception as exc:
                # Closed market-close orders often 500 on lookup — settle from last_matched.
                log_fn = log.debug if last_matched else log.warning
                log_fn(
                    "[1PC] etoro_order_lookup on_close failed session=%s order_id=%s err=%s",
                    session_id,
                    order_id,
                    exc,
                )

        buy = float(entry_price or 0)
        if fill.get("buy"):
            buy = float(fill["buy"])
        elif last_matched:
            open_rate = _position_buy_price(last_matched)
            if open_rate:
                buy = float(open_rate)

        # Prefer trade/history (exact closeRate + netProfit by positionId/orderId).
        # Demo usually 403/404 — then fall back to fresh LTP / last mark.
        history_trade: dict[str, Any] | None = None
        for attempt_n in range(3):
            try:
                history_trade = await client.afind_closed_trade(
                    position_id=position_id or fill.get("position_id"),
                    order_id=order_id,
                )
                log.info(
                    "[1PC] etoro_trade_history session=%s attempt=%s position_id=%s "
                    "order_id=%s try=%s trade=%s",
                    session_id,
                    attempt_id,
                    position_id,
                    order_id,
                    attempt_n + 1,
                    json.dumps(history_trade, default=str) if history_trade else None,
                )
                if history_trade:
                    break
            except Exception as exc:
                log.info(
                    "[1PC] etoro_trade_history unavailable session=%s try=%s err=%s",
                    session_id,
                    attempt_n + 1,
                    exc,
                )
                break
            if attempt_n < 2:
                await asyncio.sleep(1.5)

        live_ltp: float | None = None
        symbol = str(attempt.get("symbol") or "")
        token = str(attempt.get("symboltoken") or "")
        if not history_trade and (symbol or token):
            try:
                live_ltp = await client.aget_ltp("ETORO", symbol, token)
                log.info(
                    "[1PC] etoro_close_ltp session=%s attempt=%s symbol=%s token=%s ltp=%s "
                    "last_mark=%s last_broker_pnl=%s",
                    session_id,
                    attempt_id,
                    symbol,
                    token,
                    live_ltp,
                    last_mark,
                    last_broker_pnl,
                )
            except Exception as exc:
                log.warning(
                    "[1PC] etoro_close_ltp failed session=%s symbol=%s err=%s",
                    session_id,
                    symbol,
                    exc,
                )

        exit_price = 0.0
        close_reason = "closed"
        sell_source = "none"
        realized_pnl: float | None = None
        tp = float(attempt.get("take_profit_price") or 0)
        sl = float(attempt.get("stop_loss_price") or 0)

        if history_trade:
            hist_buy = _as_float(history_trade.get("openRate") or history_trade.get("OpenRate"))
            hist_sell = _as_float(history_trade.get("closeRate") or history_trade.get("CloseRate"))
            hist_pnl = _as_float(history_trade.get("netProfit") or history_trade.get("NetProfit"))
            if hist_buy and hist_buy > 0:
                buy = hist_buy
            if hist_sell and hist_sell > 0:
                exit_price = hist_sell
                sell_source = "trade_history"
            if hist_pnl is not None:
                realized_pnl = hist_pnl
        elif live_ltp and live_ltp > 0:
            exit_price = float(live_ltp)
            sell_source = "live_ltp"
        elif last_mark and last_mark > 0:
            exit_price = float(last_mark)
            sell_source = "last_mark"
        elif last_broker_pnl is not None and buy > 0 and quantity > 0:
            exit_price = buy + (float(last_broker_pnl) / quantity)
            sell_source = "last_broker_pnl"
            close_reason = "closed_broker_pnl"
        else:
            exit_price = buy
            sell_source = "buy_fallback"

        if sell_source != "trade_history":
            # Classify TP/SL for outcome labeling, but never overwrite the exit
            # price with the bracket target (that invents fills like Trade Story mismatches).
            if exit_price > 0 and tp and exit_price >= tp * 0.999:
                close_reason = "take_profit"
            elif exit_price > 0 and sl and exit_price <= sl * 1.001:
                close_reason = "stop_loss"

        if forced_close_reason:
            close_reason = forced_close_reason

        if realized_pnl is None and buy > 0 and quantity > 0 and exit_price > 0:
            realized_pnl = (exit_price - buy) * quantity

        fresh_attempt = self.store.get_attempt(attempt_id) or attempt
        updates: dict[str, Any] = {}
        if buy > 0:
            updates["entry_price"] = buy
            fresh_attempt = {**fresh_attempt, "entry_price": buy}
        if fill.get("position_id") and not fresh_attempt.get("position_id"):
            updates["position_id"] = fill["position_id"]
            fresh_attempt = {**fresh_attempt, "position_id": fill["position_id"]}
        if updates:
            self.store.update_attempt(attempt_id, updates)

        log.info(
            "[1PC] etoro_close_resolved session=%s attempt=%s position_id=%s order_id=%s "
            "buy=%s sell=%s pnl=%s reason=%s sell_source=%s lookup_state=%s "
            "live_ltp=%s last_mark=%s last_broker_pnl=%s",
            session_id,
            attempt_id,
            fresh_attempt.get("position_id") or position_id,
            order_id,
            buy,
            exit_price,
            realized_pnl,
            close_reason,
            sell_source,
            fill.get("state"),
            live_ltp,
            last_mark,
            last_broker_pnl,
        )

        await self._complete_attempt(
            session,
            fresh_attempt,
            exit_price=float(exit_price),
            close_reason=close_reason,
            realized_pnl=float(realized_pnl) if realized_pnl is not None else None,
        )

    async def _complete_attempt(
        self,
        session: dict[str, Any],
        attempt: dict[str, Any],
        *,
        exit_price: float,
        close_reason: str,
        realized_pnl: float | None = None,
    ) -> None:
        session_id = session["id"]
        self.store.set_state(session_id, "evaluating")
        entry_price = float(attempt.get("entry_price") or 0)
        quantity = float(attempt.get("quantity") or 0)
        capital = float(attempt.get("capital") or 0)
        if realized_pnl is not None:
            pnl = round(float(realized_pnl), 2)
        else:
            pnl = round((exit_price - entry_price) * quantity, 2) if entry_price and quantity else 0.0
        pnl_pct = round(((exit_price - entry_price) / entry_price) * 100.0, 4) if entry_price else 0.0
        outcome = "win" if pnl > 0 else "loss" if pnl < 0 else "flat"
        cumulative = float(session.get("cumulative_pnl") or 0) + pnl
        target = float(session.get("target_dollars") or 0)
        max_attempts = int(session.get("max_attempts") or 3)
        attempt_number = int(attempt.get("attempt_number") or 0)

        self.store.update_attempt(
            attempt["id"],
            {
                "exit_price": exit_price,
                "realized_pnl": pnl,
                "realized_pnl_pct": pnl_pct,
                "outcome": outcome,
                "close_reason": close_reason,
                "status": "closed",
                "finished_at": _now_utc(),
            },
        )
        self.store.update_session(
            session_id,
            {
                "cumulative_pnl": round(cumulative, 2),
                "active_order_id": None,
                "active_position_id": None,
                "active_execution_id": None,
            },
        )

        try:
            get_trades_pnl_store().record_exit(
                execution_id=f"1pc-{attempt['id']}",
                position_id=attempt.get("position_id"),
                exit_price=exit_price,
                entry_price=entry_price,
                pnl=pnl,
                pnl_pct=pnl_pct,
                close_reason=close_reason,
            )
        except Exception as exc:
            log.debug("[1PC] trades_pnl exit skipped: %s", exc)

        candidate = attempt.get("candidate") or {}
        will_retry = cumulative < target and attempt_number < max_attempts
        self.store.append_event(
            session_id,
            "attempt_completed",
            state="evaluating",
            payload={
                "attempt_id": attempt["id"],
                "attempt_number": attempt_number,
                "max_attempts": max_attempts,
                "symbol": attempt.get("symbol"),
                "name": candidate.get("instrument_name") or candidate.get("name"),
                "logo50x50": candidate.get("logo50x50"),
                "order_id": attempt.get("order_id"),
                "position_id": attempt.get("position_id"),
                "buy": entry_price,
                "sell": exit_price,
                "profit_amount": pnl,
                "profit_pct": pnl_pct,
                "close_reason": close_reason,
                "outcome": outcome,
                "cumulative_pnl": round(cumulative, 2),
                "target_dollars": target,
                "will_retry": will_retry,
                "capital": capital,
            },
        )

        refreshed = self.store.get_session(session_id) or session
        if cumulative >= target:
            await self._finish_session(
                refreshed,
                outcome="target_hit",
                reason=f"Reached target ${target:.2f}",
            )
            return
        if attempt_number >= max_attempts:
            await self._finish_session(
                refreshed,
                outcome="max_attempts",
                reason=f"Reached max attempts ({max_attempts})",
            )
            return
        self.store.set_state(session_id, "screening")

    async def _finish_session(
        self,
        session: dict[str, Any],
        *,
        outcome: str,
        reason: str,
    ) -> None:
        session_id = session["id"]
        current = self.store.get_session(session_id) or session
        if current.get("state") in TERMINAL_STATES:
            return
        cumulative = float(current.get("cumulative_pnl") or 0)
        target = float(current.get("target_dollars") or 0)
        state = "finished"
        self.store.set_state(
            session_id,
            state,
            reason=reason,
            extra={
                "active_order_id": None,
                "active_position_id": None,
                "active_execution_id": None,
            },
        )
        self.store.append_event(
            session_id,
            "session_finished",
            state=state,
            payload={
                "outcome": outcome,
                "reason": reason,
                "cumulative_pnl": cumulative,
                "target_dollars": target,
                "attempt_count": current.get("attempt_count") or 0,
                "hit_target": cumulative >= target,
            },
        )


_engine: OnePercentSessionEngine | None = None


def get_one_percent_session_engine() -> OnePercentSessionEngine:
    global _engine
    if _engine is None:
        _engine = OnePercentSessionEngine()
    return _engine
