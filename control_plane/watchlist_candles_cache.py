"""In-memory cache for watchlist OHLCV candle fetches (avoids repeat eToro API calls)."""

from __future__ import annotations

import os
import time
from typing import Any

WATCHLIST_CANDLES_CACHE_TTL_SEC = float(os.getenv("WATCHLIST_CANDLES_CACHE_TTL_SEC", "45"))

_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _ttl_sec() -> float:
    raw = os.getenv("WATCHLIST_CANDLES_CACHE_TTL_SEC", "45").strip()
    try:
        return max(5.0, float(raw))
    except ValueError:
        return WATCHLIST_CANDLES_CACHE_TTL_SEC


def watchlist_candles_cache_key(
    account_env: str,
    symbol: str,
    token: str,
    count: int,
    *,
    history: bool = False,
    start: int | None = None,
    end: int | None = None,
) -> str:
    symbol_key = symbol.strip().upper()
    token_key = str(token).strip()
    env_key = account_env.strip().lower()
    if history:
        return f"{env_key}:{symbol_key}:{token_key}:hist:{int(start or 0)}:{int(end or 0)}:{int(count)}"
    return f"{env_key}:{symbol_key}:{token_key}:{int(count)}"


def get_cached_watchlist_candles(key: str) -> list[dict[str, Any]] | None:
    entry = _cache.get(key)
    if not entry:
        return None
    age = time.time() - entry[0]
    if age > _ttl_sec():
        _cache.pop(key, None)
        return None
    return [dict(row) for row in entry[1]]


def put_cached_watchlist_candles(key: str, candles: list[dict[str, Any]]) -> None:
    if not candles:
        return
    _cache[key] = (time.time(), [dict(row) for row in candles])


def invalidate_watchlist_candles_cache() -> None:
    _cache.clear()
