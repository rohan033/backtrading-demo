"""Server-side eToro websocket subscriptions for open portfolio positions."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from brokers.interfaces import Subscription

log = logging.getLogger("backtrading")

POLL_SECONDS = 15.0
_positions_subscriptions: dict[str, dict[str, Subscription]] = {}
_refresh_lock = asyncio.Lock()
_monitor_task: asyncio.Task | None = None


def _feed_key(account_env: str) -> str:
    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    return f"etoro:{env}"


def _instrument_id(record: dict[str, Any]) -> str | None:
    raw = (
        record.get("instrumentID")
        or record.get("instrumentId")
        or record.get("InstrumentID")
        or record.get("symboltoken")
    )
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _symbol_label(record: dict[str, Any]) -> str:
    for key in ("tradingsymbol", "symbol", "displayName", "instrument_display_name"):
        value = record.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    token = _instrument_id(record)
    return token or "?"


def subscriptions_from_positions(
    account_env: str,
    positions: list[dict[str, Any]],
) -> dict[str, Subscription]:
    bucket: dict[str, Subscription] = {}
    for record in positions:
        token = _instrument_id(record)
        if not token:
            continue
        bucket[token] = Subscription(
            exchange="ETORO",
            symbol=_symbol_label(record),
            token=token,
        )
    return bucket


async def sync_positions_feed(account_env: str, positions: list[dict[str, Any]]) -> int:
    """Keep eToro websocket topics aligned with open positions for one account env."""
    from api.watchlist_feed import get_watchlist_feed_hub

    feed_key = _feed_key(account_env)
    bucket = subscriptions_from_positions(account_env, positions)

    async with _refresh_lock:
        _positions_subscriptions[feed_key] = bucket
        grouped = {key: dict(value) for key, value in _positions_subscriptions.items()}
        await get_watchlist_feed_hub().set_positions_subscriptions(grouped)

    count = len(bucket)
    if count:
        log.debug("[POSITIONS_FEED] Synced %d websocket subscription(s) env=%s", count, account_env)
    return count


async def refresh_positions_feed_subscriptions() -> int:
    """Poll eToro /pnl for demo + live and refresh server-side position websocket subs."""
    from control_plane.instrument_resolve import _etoro_trading_client

    total = 0
    for env in ("demo", "live"):
        try:
            client = await _etoro_trading_client(env)
            positions = await client.aget_positions()
            total += await sync_positions_feed(env, positions)
        except Exception as exc:
            log.debug("[POSITIONS_FEED] Refresh failed env=%s: %s", env, exc)
    return total


async def _monitor_loop() -> None:
    while True:
        try:
            await refresh_positions_feed_subscriptions()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("[POSITIONS_FEED] Monitor tick failed: %s", exc)
        await asyncio.sleep(POLL_SECONDS)


async def start_positions_feed_monitor() -> None:
    global _monitor_task
    if _monitor_task and not _monitor_task.done():
        return
    await refresh_positions_feed_subscriptions()
    _monitor_task = asyncio.create_task(_monitor_loop(), name="positions-live-feed")
    log.info("[POSITIONS_FEED] Started (every %.0fs)", POLL_SECONDS)


async def stop_positions_feed_monitor() -> None:
    global _monitor_task
    if _monitor_task:
        _monitor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _monitor_task
        _monitor_task = None
    log.info("[POSITIONS_FEED] Stopped")
