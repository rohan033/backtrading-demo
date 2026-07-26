"""Websocket-backed live quotes for agentic profit tracking."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from brokers.interfaces import Subscription

log = logging.getLogger("backtrading")

# (account_env, instrument_token) -> [(session_id, ticker), ...]
_token_bindings: dict[tuple[str, str], list[tuple[str, str]]] = {}
# (session_id, account_env, ticker) -> instrument_token
_ticker_tokens: dict[tuple[str, str, str], str] = {}
_listener_registered = False
_refresh_lock = asyncio.Lock()


def _feed_key(broker: str, account_env: str) -> str:
    return f"{broker}:{account_env}"


async def _on_hub_tick(broker: str, account_env: str, tick: Any) -> None:
    if (broker or "").lower() != "etoro":
        return
    ltp = float(getattr(tick, "ltp", 0) or 0)
    if ltp <= 0:
        return
    token = str(getattr(tick, "token", "") or "")
    env = str(account_env or "demo")
    if not token:
        return

    from control_plane.agentic.profit_price_tracker import get_profit_price_tracker

    tracker = get_profit_price_tracker()
    for session_id, ticker in _token_bindings.get((env, token), []):
        tracker.record(session_id, ticker, ltp, source="websocket")


async def ensure_agentic_feed_listener() -> None:
    global _listener_registered
    if _listener_registered:
        return
    from api.watchlist_feed import get_watchlist_feed_hub

    get_watchlist_feed_hub().add_tick_listener(_on_hub_tick)
    _listener_registered = True
    log.info("[AGENTIC_FEED] Registered websocket tick listener")


async def refresh_agentic_feed_subscriptions() -> int:
    """Resolve running-session tickers and sync server-side eToro websocket subs."""
    from api.watchlist_feed import get_watchlist_feed_hub
    from control_plane.agentic.broker import resolve_instrument_id
    from control_plane.agentic.session_store import get_agentic_session_store

    async with _refresh_lock:
        store = get_agentic_session_store()
        running = store.list_sessions_by_status("running")

        new_bindings: dict[tuple[str, str], list[tuple[str, str]]] = {}
        new_ticker_tokens: dict[tuple[str, str, str], str] = {}
        grouped: dict[str, dict[str, Subscription]] = {}

        for session in running:
            session_id = str(session["id"])
            env = str(session.get("account_env") or "demo")
            config = session.get("config") or {}
            tickers: set[str] = set()
            for row in store.list_positions(session_id, states=("open",)):
                tickers.add(str(row["ticker"]).upper())
            for row in config.get("tickers") or []:
                text = str(row or "").strip()
                if text:
                    tickers.add(text.upper())

            for ticker in sorted(tickers):
                instrument_id = await resolve_instrument_id(env, ticker)
                if instrument_id is None:
                    continue
                token = str(instrument_id)
                feed_key = _feed_key("etoro", env)
                grouped.setdefault(feed_key, {})[token] = Subscription(
                    exchange="ETORO",
                    symbol=ticker,
                    token=token,
                )
                bind_key = (env, token)
                new_bindings.setdefault(bind_key, []).append((session_id, ticker))
                new_ticker_tokens[(session_id, env, ticker)] = token

        global _token_bindings, _ticker_tokens
        _token_bindings = new_bindings
        _ticker_tokens = new_ticker_tokens

        await get_watchlist_feed_hub().set_agentic_subscriptions(grouped)
        count = sum(len(bucket) for bucket in grouped.values())
        if count:
            log.debug("[AGENTIC_FEED] Synced %d websocket subscription(s)", count)
        return count


def get_ws_price(session_id: str, ticker: str, account_env: str) -> float | None:
    """Latest websocket LTP for a session ticker (None if not subscribed yet)."""
    env = str(account_env or "demo")
    token = _ticker_tokens.get((str(session_id), env, str(ticker).upper()))
    if not token:
        return None
    from api.watchlist_feed import get_watchlist_feed_hub

    return get_watchlist_feed_hub().get_last_ltp("etoro", env, token)


async def startup() -> None:
    await ensure_agentic_feed_listener()
    await refresh_agentic_feed_subscriptions()
