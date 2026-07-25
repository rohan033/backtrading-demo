"""In-memory eToro search result cache with epoch invalidation."""

from __future__ import annotations

import time
from typing import Any

SEARCH_CACHE_TTL_SEC = 60.0

_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_cache_epoch = 0


def invalidate_etoro_search_cache() -> None:
    global _cache_epoch
    _cache_epoch += 1
    _cache.clear()


def current_cache_epoch() -> int:
    return _cache_epoch


def get_cached_search(key: str, epoch: int) -> list[dict[str, Any]] | None:
    if epoch != _cache_epoch:
        return None
    entry = _cache.get(key)
    if not entry:
        return None
    age = time.time() - entry[0]
    if age > SEARCH_CACHE_TTL_SEC:
        _cache.pop(key, None)
        return None
    return [dict(row) for row in entry[1]]


def put_cached_search(key: str, epoch: int, rows: list[dict[str, Any]]) -> None:
    if epoch != _cache_epoch:
        return
    _cache[key] = (time.time(), [dict(row) for row in rows])
