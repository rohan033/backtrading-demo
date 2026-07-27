"""Server-side auto-ladder for Positions tab — partial trims on pullback."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

from brokers.etoro.order_helpers import (
    classify_order_poll_outcome,
    resolve_ladder_close_units,
)
from control_plane.agentic.profit_planner import evaluate_ladder
from control_plane.ladder_levels import build_ladder_levels
from control_plane.position_ladder_store import (
    TRIM_FRACTION,
    _normalize_gain_fractions,
    _normalize_trim_fraction,
    get_position_ladder_store,
)

log = logging.getLogger("backtrading")

POLL_SECONDS = 12.0
MIN_TRIM_UNITS = 1.0
MIN_TRIM_INTERVAL_SEC = 3.5
ORDER_VERIFY_TIMEOUT_SEC = 20.0
ORDER_VERIFY_POLL_SEC = 2.0

_last_trim_at: dict[str, float] = {}


def _build_levels(
    state: dict[str, Any],
    buy: float,
    peak: float,
    *,
    gain_fractions: list[float] | None = None,
    trim_fraction: float | None = None,
) -> list[dict[str, Any]]:
    fractions = gain_fractions or _normalize_gain_fractions(state.get("gain_fractions"))
    trim = trim_fraction if trim_fraction is not None else _normalize_trim_fraction(state.get("trim_fraction"))
    return build_ladder_levels(
        state,
        buy,
        peak,
        gain_fractions=fractions,
        trim_fraction=trim,
    )


def _plan_from_state(state: dict[str, Any], buy: float, peak: float, *, active: bool) -> dict[str, Any]:
    levels = _build_levels(state, buy, peak)
    unhit = [level for level in levels if not level.get("hit")]
    return {
        "active": active,
        "peak_price": peak,
        "levels": levels,
        "remaining_fraction": float(state.get("remaining_fraction") or 1.0),
        "entry_units": state.get("entry_units"),
        "last_hit_price": state.get("last_hit_price"),
        "next_level": max(unhit, key=lambda row: float(row.get("price") or 0.0)) if unhit else None,
    }


async def _etoro_client(account_env: str):
    from control_plane.instrument_resolve import _etoro_trading_client

    return await _etoro_trading_client(account_env)


async def _fetch_live_price(client: Any, instrument_id: int | None, fallback: float | None) -> float:
    if instrument_id is None:
        return float(fallback or 0.0)
    try:
        rates = await client.aget_rates([int(instrument_id)])
        if rates:
            price = client._rate_ltp(rates[0])
            if price is not None and float(price) > 0:
                return float(price)
    except Exception as exc:
        log.debug("[POS_LADDER] rate fetch failed instrument=%s: %s", instrument_id, exc)
    return float(fallback or 0.0)


async def _find_broker_position(
    client: Any, broker_position_id: str
) -> dict[str, Any] | None:
    positions = await client.aget_positions()
    want = str(broker_position_id)
    for row in positions:
        pid = str(row.get("positionID") or row.get("positionId") or "")
        if pid == want:
            return row
    return None


def _position_units(row: dict[str, Any]) -> float:
    for key in ("units", "Units", "amount"):
        value = row.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return 0.0


def _position_open_rate(row: dict[str, Any]) -> float:
    for key in ("openRate", "OpenRate", "open_rate"):
        value = row.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return 0.0


def _trim_key(account_env: str, broker_position_id: str) -> str:
    return f"{account_env}:{broker_position_id}"


def _order_id_from_close_result(result: dict[str, Any] | None) -> str | None:
    if not isinstance(result, dict):
        return None
    response = result.get("response")
    if not isinstance(response, dict):
        return None
    for key in ("orderID", "orderId", "OrderID", "order_id"):
        value = response.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


async def _has_pending_close(client: Any, broker_position_id: str) -> bool:
    """True when eToro already has an in-flight close order for this position."""
    try:
        snapshot = await client.aget_orders_snapshot()
    except Exception as exc:
        log.debug("[POS_LADDER] orders snapshot failed: %s", exc)
        return False

    want = str(broker_position_id)
    for bucket in ("orders_for_close", "ordersForClose"):
        for order in snapshot.get(bucket) or []:
            if not isinstance(order, dict):
                continue
            pid = str(order.get("positionID") or order.get("positionId") or "")
            if pid == want:
                return True
    return False


async def _verify_close_order(client: Any, order_id: str) -> str:
    """Return fulfilled, rejected, or pending."""
    deadline = time.monotonic() + ORDER_VERIFY_TIMEOUT_SEC
    while time.monotonic() < deadline:
        try:
            lookup = await client.aget_order_status(order_id)
        except Exception as exc:
            log.debug("[POS_LADDER] order lookup failed order=%s: %s", order_id, exc)
            await asyncio.sleep(ORDER_VERIFY_POLL_SEC)
            continue
        outcome = classify_order_poll_outcome(lookup)
        if outcome == "fulfilled":
            return "fulfilled"
        if outcome == "rejected":
            return "rejected"
        await asyncio.sleep(ORDER_VERIFY_POLL_SEC)
    return "pending"


async def _partial_close(
    account_env: str,
    broker_position_id: str,
    *,
    units: float | None,
    full_close: bool,
    instrument_id: int | None,
    ticker: str,
    level_id: str,
    price: float,
) -> bool:
    if not full_close and (units is None or units < MIN_TRIM_UNITS):
        return False

    trim_key = _trim_key(account_env, broker_position_id)
    last_at = _last_trim_at.get(trim_key, 0.0)
    if time.monotonic() - last_at < MIN_TRIM_INTERVAL_SEC:
        log.debug(
            "[POS_LADDER] Skip trim %s %s position=%s — rate limit (%.1fs)",
            ticker,
            level_id,
            broker_position_id,
            MIN_TRIM_INTERVAL_SEC,
        )
        return False

    try:
        client = await _etoro_client(account_env)
        if await _has_pending_close(client, broker_position_id):
            log.info(
                "[POS_LADDER] Skip trim %s %s position=%s — close order already pending",
                ticker,
                level_id,
                broker_position_id,
            )
            return False

        result = await client.aclose_position(
            str(broker_position_id),
            units=None if full_close else units,
            instrument_id=int(instrument_id) if instrument_id else None,
        )
        order_id = _order_id_from_close_result(result)
        units_label = "ALL" if full_close else f"{units:.0f}"
        if order_id:
            outcome = await _verify_close_order(client, order_id)
            if outcome == "rejected":
                log.warning(
                    "[POS_LADDER] Trim rejected %s %s position=%s order=%s units=%s",
                    ticker,
                    level_id,
                    broker_position_id,
                    order_id,
                    units_label,
                )
                return False
            if outcome == "pending":
                log.warning(
                    "[POS_LADDER] Trim ambiguous %s %s position=%s order=%s units=%s",
                    ticker,
                    level_id,
                    broker_position_id,
                    order_id,
                    units_label,
                )
                _last_trim_at[trim_key] = time.monotonic()
                return False

        _last_trim_at[trim_key] = time.monotonic()
        log.info(
            "[POS_LADDER] Trim %s %s position=%s units=%s @ %.4f order=%s",
            ticker,
            level_id,
            broker_position_id,
            units_label,
            price,
            order_id or "-",
        )
        return True
    except Exception as exc:
        log.warning(
            "[POS_LADDER] Trim failed %s %s position=%s units=%s: %s",
            ticker,
            level_id,
            broker_position_id,
            "ALL" if full_close else str(units),
            exc,
        )
        return False


async def evaluate_armed_position(state: dict[str, Any]) -> dict[str, Any] | None:
    """One monitor tick for a single armed position. Returns updated public state."""
    store = get_position_ladder_store()
    account_env = state["account_env"]
    pid = state["broker_position_id"]
    ticker = state["ticker"]

    client = await _etoro_client(account_env)
    broker_row = await _find_broker_position(client, pid)
    if broker_row is None:
        store.delete(account_env, pid)
        return None

    units_now = _position_units(broker_row)
    if units_now <= MIN_TRIM_UNITS:
        store.delete(account_env, pid)
        return None

    open_rate = _position_open_rate(broker_row) or float(state.get("entry_price") or 0.0)
    instrument_id = state.get("instrument_id")
    if instrument_id is None:
        instrument_id = broker_row.get("instrumentID") or broker_row.get("instrumentId")
        if instrument_id is not None:
            store.update_runtime(account_env, pid, instrument_id=int(instrument_id))

    ltp = broker_row.get("currentRate") or broker_row.get("CurrentRate")
    try:
        live_price = await _fetch_live_price(
            client,
            int(instrument_id) if instrument_id is not None else None,
            float(ltp) if ltp is not None else open_rate,
        )
    except (TypeError, ValueError):
        live_price = open_rate

    if live_price <= 0:
        return store.get(account_env, pid)

    entry_units = float(state.get("entry_units") or units_now)
    if state.get("entry_units") is None:
        store.update_runtime(
            account_env,
            pid,
            entry_units=entry_units,
            entry_price=open_rate,
        )

    peak = max(float(state.get("peak_price") or open_rate), live_price, open_rate)
    peak_gain_pct = (peak - open_rate) / open_rate * 100.0 if open_rate > 0 else 0.0
    active = peak_gain_pct >= 0.35

    plan = _plan_from_state(state, open_rate, peak, active=active)
    triggered: list[dict[str, Any]] = []
    if active:
        triggered = evaluate_ladder(plan, buy_price=open_rate, price=live_price)
        # One trim per poll — eToro rejects stacked partial closes + 20/min execution cap.
        if len(triggered) > 1:
            keep = triggered[0]
            for level in plan.get("levels") or []:
                if level is keep:
                    continue
                if level in triggered:
                    level["hit"] = False
                    level.pop("hit_price", None)
                    level.pop("hit_at", None)
            triggered = [keep]

    remaining = float(plan.get("remaining_fraction") or 1.0)
    last_hit = state.get("last_hit_price")
    trim_fraction = _normalize_trim_fraction(state.get("trim_fraction"))

    for level in triggered:
        level_id = str(level.get("id") or "")
        trim_of_original = min(trim_fraction, remaining)
        if trim_of_original <= 0:
            continue
        units_to_close = min(units_now * (trim_of_original / remaining), entry_units * trim_of_original)
        units_to_close = min(units_to_close, units_now)
        close_units, full_close = resolve_ladder_close_units(units_to_close, units_now)
        if not full_close and close_units is None:
            continue
        if not full_close and (close_units or 0) < MIN_TRIM_UNITS:
            continue
        ok = await _partial_close(
            account_env,
            pid,
            units=close_units,
            full_close=full_close,
            instrument_id=int(instrument_id) if instrument_id is not None else None,
            ticker=ticker,
            level_id=level_id,
            price=live_price,
        )
        if not ok:
            # Do not mark rung hit — retry next poll once broker accepts the close.
            level["hit"] = False
            level.pop("hit_price", None)
            level.pop("hit_at", None)
            break
        remaining = max(0.0, remaining - trim_of_original)
        last_hit = live_price
        hit_patch = {
            "L1": "l1_hit",
            "L2": "l2_hit",
            "L3": "l3_hit",
        }.get(level_id)
        state_after = store.get(account_env, pid) or state
        if hit_patch:
            state_after = {**state_after, hit_patch: True}
        merged_state = {
            **state_after,
            "levels_json": json.dumps(plan.get("levels") or []),
        }
        runtime_patch: dict[str, Any] = {
            "peak_price": peak,
            "remaining_fraction": round(remaining, 6),
            "last_hit_price": last_hit,
            "levels_json": json.dumps(_build_levels(merged_state, open_rate, peak)),
        }
        if hit_patch:
            runtime_patch[hit_patch] = True
        store.update_runtime(account_env, pid, **runtime_patch)
        state = store.get(account_env, pid) or state
        sold_units = units_now if full_close else float(close_units or 0)
        units_now = max(0.0, units_now - sold_units)
        if full_close or units_now <= MIN_TRIM_UNITS:
            store.update_runtime(account_env, pid, remaining_fraction=0.0)
            store.set_auto_ladder(
                account_env,
                pid,
                enabled=False,
                ticker=ticker,
            )
            break

    if not triggered:
        store.update_runtime(
            account_env,
            pid,
            peak_price=peak,
            levels_json=json.dumps(_build_levels(state, open_rate, peak)),
        )

    updated = store.get(account_env, pid)
    if updated:
        updated["levels"] = _build_levels(updated, open_rate, peak)
        updated["live_price"] = live_price
        updated["next_level"] = plan.get("next_level")
        updated["active"] = active
    return updated


class PositionLadderMonitor:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="position-ladder-monitor")
        log.info("[POS_LADDER] Started (every %.0fs)", POLL_SECONDS)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        log.info("[POS_LADDER] Stopped")

    async def _run(self) -> None:
        while True:
            try:
                await self.tick_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.error("[POS_LADDER] Tick failed: %s", exc, exc_info=True)
            await asyncio.sleep(POLL_SECONDS)

    async def tick_once(self) -> None:
        store = get_position_ladder_store()
        armed = store.list_armed()
        if not armed:
            return
        for state in armed:
            try:
                await evaluate_armed_position(state)
            except Exception as exc:
                log.warning(
                    "[POS_LADDER] Position %s failed: %s",
                    state.get("broker_position_id"),
                    exc,
                )


_monitor: PositionLadderMonitor | None = None


def get_position_ladder_monitor() -> PositionLadderMonitor:
    global _monitor
    if _monitor is None:
        _monitor = PositionLadderMonitor()
    return _monitor
