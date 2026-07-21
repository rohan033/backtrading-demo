"""Settle closed-position P&L from eToro trade/history (Trade Story source of truth)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("backtrading")

# In-memory status for UI polling after a close when history lagged.
_settlement_jobs: dict[str, dict[str, Any]] = {}
_background_tasks: set[asyncio.Task] = set()


def _as_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if num == num else None  # NaN check


def settled_fields_from_closed_trade(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Map an eToro trade/history row into notify / trades_pnl fields."""
    if not isinstance(row, dict):
        return None
    open_rate = _as_float(row.get("openRate") or row.get("OpenRate"))
    close_rate = _as_float(row.get("closeRate") or row.get("CloseRate"))
    net_profit = _as_float(row.get("netProfit") or row.get("NetProfit"))
    investment = _as_float(
        row.get("investment")
        or row.get("initialInvestment")
        or row.get("InitialInvestment")
    )
    units = _as_float(row.get("units") or row.get("Units"))
    if open_rate is None or close_rate is None:
        return None
    if net_profit is None and units is not None:
        net_profit = (close_rate - open_rate) * units

    pnl_pct: float | None = None
    if net_profit is not None and investment and investment > 0:
        pnl_pct = round((net_profit / investment) * 100.0, 4)
    elif open_rate > 0:
        pnl_pct = round(((close_rate - open_rate) / open_rate) * 100.0, 4)

    out: dict[str, Any] = {
        "buy_price": open_rate,
        "sell_price": close_rate,
        "pnl": round(net_profit, 2) if net_profit is not None else None,
        "pnl_pct": pnl_pct,
        "units": units,
        "investment": investment,
        "fees": _as_float(row.get("fees") or row.get("Fees")),
        "order_id": row.get("orderId") or row.get("orderID") or row.get("OrderID"),
        "instrument_id": row.get("instrumentId") or row.get("instrumentID"),
        "open_timestamp": row.get("openTimestamp") or row.get("openDateTime"),
        "close_timestamp": row.get("closeTimestamp") or row.get("closeDateTime"),
        "settled_from": "trade_history",
    }
    return out


async def settle_closed_trade(
    client: Any,
    *,
    position_id: str | int | None,
    order_id: str | int | None = None,
    attempts: int = 4,
    delay_sec: float = 0.8,
) -> dict[str, Any] | None:
    """Poll trade/history until the closed row appears (fills can lag a second)."""
    if not hasattr(client, "await_settled_closed_trade"):
        row = None
        for i in range(max(1, attempts)):
            try:
                row = await client.afind_closed_trade(
                    position_id=position_id,
                    order_id=order_id,
                )
            except Exception as exc:
                log.info(
                    "[ETORO_SETTLE] history lookup failed position=%s try=%s err=%s",
                    position_id,
                    i + 1,
                    exc,
                )
                row = None
            if row:
                break
            if i + 1 < attempts:
                await asyncio.sleep(delay_sec)
        return settled_fields_from_closed_trade(row)

    try:
        row = await client.await_settled_closed_trade(
            position_id=position_id,
            order_id=order_id,
            attempts=attempts,
            delay_sec=delay_sec,
        )
    except Exception as exc:
        log.info(
            "[ETORO_SETTLE] history lookup failed position=%s err=%s",
            position_id,
            exc,
        )
        return None
    fields = settled_fields_from_closed_trade(row)
    if fields:
        log.info(
            "[ETORO_SETTLE] settled position=%s buy=%s sell=%s pnl=%s pnl_pct=%s",
            position_id,
            fields.get("buy_price"),
            fields.get("sell_price"),
            fields.get("pnl"),
            fields.get("pnl_pct"),
        )
    else:
        log.info("[ETORO_SETTLE] no history row yet position=%s", position_id)
    return fields


def apply_settlement_to_notify(notify: Any, settled: dict[str, Any] | None) -> Any:
    """Overwrite client estimates with broker fill when available."""
    if notify is None or not settled:
        return notify
    updates = {
        "buy_price": settled.get("buy_price"),
        "sell_price": settled.get("sell_price"),
        "pnl": settled.get("pnl"),
        "pnl_pct": settled.get("pnl_pct"),
    }
    updates = {k: v for k, v in updates.items() if v is not None}
    if not updates:
        return notify
    if hasattr(notify, "model_copy"):
        return notify.model_copy(update=updates)
    if hasattr(notify, "copy"):
        return notify.copy(update=updates)
    for key, value in updates.items():
        setattr(notify, key, value)
    return notify


def get_settlement_job(position_id: str) -> dict[str, Any] | None:
    job = _settlement_jobs.get(str(position_id))
    return dict(job) if job else None


def _set_settlement_job(position_id: str, payload: dict[str, Any]) -> None:
    _settlement_jobs[str(position_id)] = {
        **payload,
        "position_id": str(position_id),
    }


async def _run_background_resettle(
    *,
    account_env: str,
    position_id: str,
    ticker: str | None,
    source: str | None,
    close_reason: str | None,
    order_id: str | None = None,
    client_factory: Any = None,
) -> None:
    pid = str(position_id)
    env = "live" if str(account_env or "").lower() == "live" else "demo"
    _set_settlement_job(pid, {
        "status": "pending",
        "account_env": env,
        "ticker": ticker,
        "source": source,
    })
    try:
        if client_factory is None:
            from brokers.etoro.order_client import EtoroV2BracketOrderClient

            client = EtoroV2BracketOrderClient(account_env=env)
            client.generate_session()
        else:
            client = await client_factory(env)

        settled = await settle_closed_trade(
            client,
            position_id=pid,
            order_id=order_id,
            attempts=30,
            delay_sec=1.5,
        )
        if not settled:
            _set_settlement_job(pid, {
                "status": "timeout",
                "account_env": env,
                "ticker": ticker,
                "source": source,
                "message": "eToro trade history did not appear in time",
            })
            log.info("[ETORO_SETTLE] background timeout position=%s", pid)
            return

        if ticker:
            try:
                from control_plane.trades_pnl_store import get_trades_pnl_store

                get_trades_pnl_store().record_completed_ui_trade(
                    position_id=pid,
                    source=source or "positions",
                    broker="etoro",
                    account_env=env,
                    symbol=ticker,
                    entry_price=settled.get("buy_price"),
                    exit_price=settled.get("sell_price"),
                    pnl=settled.get("pnl"),
                    pnl_pct=settled.get("pnl_pct"),
                    close_reason=close_reason,
                )
            except Exception as exc:
                log.warning(
                    "[ETORO_SETTLE] background DB update failed position=%s err=%s",
                    pid,
                    exc,
                )

        _set_settlement_job(pid, {
            "status": "settled",
            "account_env": env,
            "ticker": ticker,
            "source": source,
            "settled": settled,
        })
        log.info(
            "[ETORO_SETTLE] background settled position=%s sell=%s pnl=%s",
            pid,
            settled.get("sell_price"),
            settled.get("pnl"),
        )
    except Exception as exc:
        _set_settlement_job(pid, {
            "status": "failed",
            "account_env": env,
            "ticker": ticker,
            "source": source,
            "message": str(exc),
        })
        log.warning("[ETORO_SETTLE] background failed position=%s err=%s", pid, exc)


def schedule_background_resettle(
    *,
    account_env: str,
    position_id: str,
    ticker: str | None = None,
    source: str | None = None,
    close_reason: str | None = None,
    order_id: str | None = None,
    client_factory: Any = None,
) -> dict[str, Any]:
    """Fire-and-forget poll of trade/history; UI can poll get_settlement_job."""
    pid = str(position_id)
    env = "live" if str(account_env or "").lower() == "live" else "demo"
    existing = get_settlement_job(pid)
    if existing and existing.get("status") == "pending":
        return existing

    _set_settlement_job(pid, {
        "status": "pending",
        "account_env": env,
        "ticker": ticker,
        "source": source,
    })
    task = asyncio.create_task(
        _run_background_resettle(
            account_env=env,
            position_id=pid,
            ticker=ticker,
            source=source,
            close_reason=close_reason,
            order_id=order_id,
            client_factory=client_factory,
        ),
        name=f"etoro-settle-{pid}",
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return get_settlement_job(pid) or {"status": "pending", "position_id": pid}
