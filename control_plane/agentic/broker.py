"""Shared eToro market-data and execution helpers for the agentic subsystem.

Wraps the existing broker plumbing (EtoroBracketTradingClient, instrument
resolution, candle fetching) behind a small async surface so the session
engine and reconciliation loop don't touch broker internals directly.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("backtrading")

FIVE_MINUTE_INTERVAL = "FiveMinutes"
FIVE_MINUTE_SECONDS = 300
ONE_MINUTE_INTERVAL = "OneMinute"
ONE_MINUTE_SECONDS = 60

_clients: dict[str, Any] = {}
_clients_lock = asyncio.Lock()

_instrument_cache: dict[tuple[str, str], int] = {}


def _normalize_env(account_env: str | None) -> str:
    return "demo" if (account_env or "demo").lower() == "demo" else "live"


async def get_agentic_etoro_client(account_env: str):
    """Cached EtoroBracketTradingClient per account env (supports SL at placement)."""
    from brokers.etoro.trading_client import EtoroBracketTradingClient

    env = _normalize_env(account_env)
    cached = _clients.get(env)
    if cached is not None:
        return cached
    async with _clients_lock:
        cached = _clients.get(env)
        if cached is not None:
            return cached
        client = EtoroBracketTradingClient(account_env=env)
        client.generate_session()
        _clients[env] = client
        return client


async def resolve_instrument_id(account_env: str, ticker: str) -> int | None:
    """Resolve a plain ticker to an eToro instrument id (cached)."""
    env = _normalize_env(account_env)
    key = (env, ticker.upper())
    cached = _instrument_cache.get(key)
    if cached is not None:
        return cached

    from control_plane.instrument_resolve import resolve_instrument

    resolved = await resolve_instrument("etoro", env, symbol=ticker)
    if not resolved or not resolved.token:
        return None
    try:
        instrument_id = int(resolved.token)
    except (TypeError, ValueError):
        return None
    _instrument_cache[key] = instrument_id
    return instrument_id


async def fetch_five_minute_candles(
    account_env: str,
    ticker: str,
    *,
    count: int = 60,
) -> list[dict[str, Any]]:
    """5-minute OHLCV candles ({time, open, high, low, close, volume})."""
    return await _fetch_candles(
        account_env,
        ticker,
        interval=FIVE_MINUTE_INTERVAL,
        count=count,
    )


async def fetch_one_minute_candles(
    account_env: str,
    ticker: str,
    *,
    count: int = 20,
) -> list[dict[str, Any]]:
    """One-minute OHLCV candles for short-window profit planning."""
    return await _fetch_candles(
        account_env,
        ticker,
        interval=ONE_MINUTE_INTERVAL,
        count=count,
    )


async def _fetch_candles(
    account_env: str,
    ticker: str,
    *,
    interval: str,
    count: int,
) -> list[dict[str, Any]]:
    from brokers.etoro.candles import aget_historical_candles

    instrument_id = await resolve_instrument_id(account_env, ticker)
    if instrument_id is None:
        return []
    client = await get_agentic_etoro_client(account_env)
    try:
        return await aget_historical_candles(
            client,
            instrument_id,
            interval=interval,
            count=max(1, min(int(count), 1000)),
            direction="desc",
        )
    except Exception as exc:
        log.debug("[AGENTIC] candle fetch failed ticker=%s: %s", ticker, exc)
        return []


async def fetch_quote(account_env: str, ticker: str) -> dict[str, Any] | None:
    """Latest quote: {price, bid, ask, spread_pct} (spread_pct nullable)."""
    instrument_id = await resolve_instrument_id(account_env, ticker)
    if instrument_id is None:
        return None
    client = await get_agentic_etoro_client(account_env)
    try:
        rates = await client.aget_rates([instrument_id])
    except Exception as exc:
        log.debug("[AGENTIC] quote fetch failed ticker=%s: %s", ticker, exc)
        return None
    if not rates:
        return None
    rate = rates[0]
    bid = rate.get("bid") or rate.get("Bid")
    ask = rate.get("ask") or rate.get("Ask")
    price = client._rate_ltp(rate)
    spread_pct = None
    try:
        if bid is not None and ask is not None and float(bid) > 0:
            mid = (float(bid) + float(ask)) / 2.0
            if mid > 0:
                spread_pct = round((float(ask) - float(bid)) / mid * 100.0, 4)
    except (TypeError, ValueError):
        spread_pct = None
    if price is None:
        return None
    return {"price": float(price), "bid": bid, "ask": ask, "spread_pct": spread_pct}


def compute_atr(candles: list[dict[str, Any]], period: int = 14) -> float | None:
    """Simple ATR over the last `period` true ranges of ascending candles."""
    if len(candles) < 2:
        return None
    true_ranges: list[float] = []
    for prev, curr in zip(candles[:-1], candles[1:]):
        try:
            high = float(curr["high"])
            low = float(curr["low"])
            prev_close = float(prev["close"])
        except (KeyError, TypeError, ValueError):
            continue
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    if not true_ranges:
        return None
    window = true_ranges[-max(1, int(period)):]
    return sum(window) / len(window)


def last_closed_candle(
    candles: list[dict[str, Any]],
    *,
    now_epoch: float,
) -> dict[str, Any] | None:
    """Most recent candle whose 5-minute window has fully elapsed."""
    for candle in reversed(candles):
        try:
            if int(candle["time"]) + FIVE_MINUTE_SECONDS <= now_epoch:
                return candle
        except (KeyError, TypeError, ValueError):
            continue
    return None


async def place_market_buy_with_stop(
    account_env: str,
    ticker: str,
    *,
    amount_usd: float,
    reference_price: float,
    stop_loss: float,
) -> dict[str, Any]:
    """REAL order path: market buy by amount with stop-loss attached at placement.

    Returns {order_id, broker_position_id (may be None if fill lags), stop_loss_rate}.
    Raises on broker rejection. Callers must gate this behind dry_run=False.
    """
    instrument_id = await resolve_instrument_id(account_env, ticker)
    if instrument_id is None:
        raise RuntimeError(f"Could not resolve eToro instrument for {ticker}")
    client = await get_agentic_etoro_client(account_env)
    result = await client.abuy_with_take_profit_stop_loss(
        ltp=reference_price,
        available_capital=amount_usd,
        symbol=ticker,
        token=str(instrument_id),
        exchange="ETORO",
        take_profit_rate=None,
        stop_loss_rate=stop_loss,
    )
    order_id = result.get("order_id")
    if not order_id:
        raise RuntimeError(f"eToro rejected BUY for {ticker} (no order id)")
    position_ids = await client.await_position_ids_for_order(
        order_id, timeout_seconds=20, poll_seconds=2
    )
    return {
        "order_id": order_id,
        "broker_position_id": position_ids[0] if position_ids else None,
        "stop_loss_rate": result.get("stop_loss_rate", stop_loss),
    }


async def close_broker_position(
    account_env: str,
    ticker: str,
    broker_position_id: str,
    *,
    units: float | None = None,
) -> dict[str, Any]:
    """REAL close path (full close when units is None). Raises on broker failure."""
    instrument_id = await resolve_instrument_id(account_env, ticker)
    client = await get_agentic_etoro_client(account_env)
    return await client.aclose_position(
        broker_position_id,
        units=units,
        instrument_id=instrument_id,
    )


async def fetch_broker_positions(account_env: str) -> list[dict[str, Any]]:
    client = await get_agentic_etoro_client(account_env)
    return await client.aget_positions()


async def fetch_broker_open_index(account_env: str) -> dict[str, Any]:
    """Open broker positions indexed by position id and normalized ticker."""
    from brokers.etoro.adapters.portfolio import (
        etoro_display_symbol,
        etoro_symbol_map_for_records,
    )

    rows = await fetch_broker_positions(account_env)
    client = await get_agentic_etoro_client(account_env)
    symbol_map = await etoro_symbol_map_for_records(client, rows)
    by_id: dict[str, dict[str, Any]] = {}
    by_ticker: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        pid = row.get("positionID") or row.get("positionId")
        ticker = str(etoro_display_symbol(row, symbol_map) or "").strip().upper()
        if pid is not None:
            by_id[str(pid)] = row
        if ticker:
            by_ticker.setdefault(ticker, []).append(row)
    return {"by_id": by_id, "by_ticker": by_ticker, "rows": rows}


async def find_broker_closed_trade(
    account_env: str,
    *,
    broker_position_id: str,
) -> dict[str, Any] | None:
    """Closed-trade row with actual fill data (netProfit/closeRate) for realized PnL."""
    client = await get_agentic_etoro_client(account_env)
    try:
        return await client.afind_closed_trade(position_id=broker_position_id)
    except Exception as exc:
        log.debug(
            "[AGENTIC] closed-trade lookup failed position=%s: %s",
            broker_position_id,
            exc,
        )
        return None
