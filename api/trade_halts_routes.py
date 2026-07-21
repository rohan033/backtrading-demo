"""NASDAQ trade-halt feed endpoints backed by SQLite."""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from control_plane.trade_halts_poller import get_trade_halts_poller
from control_plane.trade_halts_store import get_trade_halts_store

router = APIRouter(prefix="/api/trade-halts", tags=["trade-halts"])


class NotifyPrefBody(BaseModel):
    enabled: bool = Field(..., description="Whether halt notifications are enabled for the ticker")


def _validate_day(day: str | None) -> str:
    target = (day or date.today().isoformat()).strip()
    try:
        datetime.strptime(target, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid day. Use YYYY-MM-DD.",
        ) from exc
    return target


@router.get(
    "",
    operation_id="list_trade_halts",
    summary="Trade halts from DB (all feed rows, or a specific day)",
)
async def list_trade_halts(
    day: str | None = Query(None, description="YYYY-MM-DD; omit for all stored feed rows"),
    symbol: str | None = Query(None, min_length=1, max_length=32),
):
    store = get_trade_halts_store()
    if day:
        target = _validate_day(day)
        if symbol:
            data = store.list_halts_for_symbol(symbol, day=target)
        else:
            data = store.list_halts_for_day(target)
        return {"status": True, "day": target, "data": data}

    if symbol:
        data = store.list_halts_for_symbol(symbol)
    else:
        data = store.list_all_halts()
    return {"status": True, "day": None, "data": data}


@router.get(
    "/notifications",
    operation_id="list_trade_halt_notifications",
    summary="Active (non-dismissed) trade-halt notifications",
)
async def list_trade_halt_notifications(limit: int = Query(50, ge=1, le=200)):
    return {
        "status": True,
        "data": get_trade_halts_store().active_notifications(limit=limit),
    }


@router.delete(
    "/notifications/{notification_id}",
    operation_id="dismiss_trade_halt_notification",
    summary="Dismiss a single trade-halt notification",
)
async def dismiss_trade_halt_notification(notification_id: str):
    ok = get_trade_halts_store().dismiss_notification(notification_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"status": True, "dismissed": notification_id}


@router.delete(
    "/notifications",
    operation_id="dismiss_all_trade_halt_notifications",
    summary="Dismiss all active trade-halt notifications",
)
async def dismiss_all_trade_halt_notifications():
    deleted = get_trade_halts_store().dismiss_all_notifications()
    return {"status": True, "dismissed": deleted}


@router.get(
    "/notify-prefs",
    operation_id="list_trade_halt_notify_prefs",
    summary="Per-ticker halt notification preferences",
)
async def list_trade_halt_notify_prefs():
    store = get_trade_halts_store()
    return {
        "status": True,
        "notifications_enabled": store.get_global_notifications_enabled(),
        "data": store.list_notify_prefs(),
    }


@router.put(
    "/notify-prefs/global",
    operation_id="set_trade_halt_global_notify_pref",
    summary="Enable or disable all halt notifications globally",
)
async def set_trade_halt_global_notify_pref(body: NotifyPrefBody):
    pref = get_trade_halts_store().set_global_notifications_enabled(body.enabled)
    return {"status": True, "data": pref}


@router.put(
    "/notify-prefs/{symbol}",
    operation_id="set_trade_halt_notify_pref",
    summary="Enable or disable halt notifications for a ticker",
)
async def set_trade_halt_notify_pref(symbol: str, body: NotifyPrefBody):
    ticker = symbol.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="symbol required")
    if ticker == "GLOBAL":
        raise HTTPException(status_code=400, detail="Use /notify-prefs/global for the global toggle")
    pref = get_trade_halts_store().set_notify_enabled(ticker, body.enabled)
    return {"status": True, "data": pref}


@router.post(
    "/poll",
    operation_id="poll_trade_halts_now",
    summary="Manually trigger a trade-halts RSS poll",
)
async def poll_trade_halts_now():
    notifications = await get_trade_halts_poller().poll_once()
    return {"status": True, "notifications": notifications}
