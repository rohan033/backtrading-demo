from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import date, timedelta
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import HTTPException

from control_plane.news_store import NewsCacheEntry, NewsStore, get_news_store

FINNHUB_BASE = "https://finnhub.io/api/v1"
NEWS_LIMIT = 20
MARKET_NEWS_CATEGORIES = frozenset({"general", "forex", "crypto", "merger"})


def news_cache_ttl_seconds() -> int:
    return max(0, int(os.getenv("NEWS_CACHE_TTL_SECONDS", "600")))


def news_cache_max_items() -> int:
    return max(NEWS_LIMIT, int(os.getenv("NEWS_CACHE_MAX_ITEMS", "50")))


def finnhub_ticker(tradingsymbol: str) -> str:
    """Map watchlist tradingsymbol to a Finnhub ticker."""
    symbol = tradingsymbol.strip().upper()
    for suffix in ("-EQ", "-BE", "-SM", "-BZ", "-BL"):
        if symbol.endswith(suffix):
            symbol = symbol[: -len(suffix)]
            break
    if "." in symbol:
        symbol = symbol.split(".", 1)[0]
    return symbol


async def _finnhub_get(path: str, params: dict[str, str | int]) -> list[dict[str, Any]]:
    token = os.getenv("FINNHUB_API_KEY", "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="FINNHUB_API_KEY is not configured")

    query = urlencode({**params, "token": token})

    def _fetch_json() -> tuple[int, str]:
        req = Request(f"{FINNHUB_BASE}{path}?{query}", headers={"User-Agent": "backtrading-demo"})
        with urlopen(req, timeout=15) as resp:
            status = int(getattr(resp, "status", 200))
            body = resp.read().decode("utf-8")
        return status, body

    try:
        status_code, body = await asyncio.to_thread(_fetch_json)
    except HTTPError as exc:
        status_code = int(getattr(exc, "code", 502))
        body = exc.read().decode("utf-8") if hasattr(exc, "read") else ""
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Finnhub request failed: {exc}") from exc

    if status_code == 429:
        raise HTTPException(status_code=429, detail="Finnhub rate limit exceeded")
    if status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Finnhub error ({status_code})")

    try:
        payload = json.loads(body) if body else []
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Finnhub returned invalid JSON") from exc

    return payload if isinstance(payload, list) else []


async def _finnhub_get_object(path: str, params: dict[str, str | int]) -> dict[str, Any]:
    token = os.getenv("FINNHUB_API_KEY", "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="FINNHUB_API_KEY is not configured")

    query = urlencode({**params, "token": token})

    def _fetch_json() -> tuple[int, str]:
        req = Request(f"{FINNHUB_BASE}{path}?{query}", headers={"User-Agent": "backtrading-demo"})
        with urlopen(req, timeout=15) as resp:
            status = int(getattr(resp, "status", 200))
            body = resp.read().decode("utf-8")
        return status, body

    try:
        status_code, body = await asyncio.to_thread(_fetch_json)
    except HTTPError as exc:
        status_code = int(getattr(exc, "code", 502))
        body = exc.read().decode("utf-8") if hasattr(exc, "read") else ""
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Finnhub request failed: {exc}") from exc

    if status_code == 429:
        raise HTTPException(status_code=429, detail="Finnhub rate limit exceeded")
    if status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Finnhub error ({status_code})")

    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Finnhub returned invalid JSON") from exc

    return payload if isinstance(payload, dict) else {}


def market_status_cache_ttl_seconds() -> int:
    return max(15, int(os.getenv("MARKET_STATUS_CACHE_TTL_SECONDS", "60")))


def _sort_news(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda row: int(row.get("datetime") or 0), reverse=True)


def _news_item_id(item: dict[str, Any]) -> int:
    try:
        return int(item.get("id") or 0)
    except (TypeError, ValueError):
        return 0


def _cache_age(entry: NewsCacheEntry | None) -> float | None:
    if not entry:
        return None
    return max(0.0, time.time() - entry.fetched_at)


def _is_fresh(entry: NewsCacheEntry | None) -> bool:
    age = _cache_age(entry)
    return age is not None and age < news_cache_ttl_seconds()


def _company_cache_key(ticker: str, days: int) -> str:
    return f"company:{ticker.upper()}:{days}"


def _market_cache_key(category: str) -> str:
    return f"market:{category.lower()}"


class NewsService:
    def __init__(self, store: NewsStore | None = None):
        self.store = store or get_news_store()
        self._locks: dict[str, asyncio.Lock] = {}
        self._market_status_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    async def market_status(self, exchange: str = "US", *, refresh: bool = False) -> dict[str, Any]:
        exchange_key = exchange.strip().upper() or "US"
        cache_key = f"status:{exchange_key}"
        cached = self._market_status_cache.get(cache_key)
        ttl = market_status_cache_ttl_seconds()

        if cached and not refresh and (time.time() - cached[0]) < ttl:
            return {
                "status": True,
                "data": cached[1],
                "meta": {"cached": True, "ageSeconds": round(time.time() - cached[0], 1)},
            }

        async with self._lock_for(cache_key):
            cached = self._market_status_cache.get(cache_key)
            if cached and not refresh and (time.time() - cached[0]) < ttl:
                return {
                    "status": True,
                    "data": cached[1],
                    "meta": {"cached": True, "ageSeconds": round(time.time() - cached[0], 1)},
                }

            payload = await _finnhub_get_object("/stock/market-status", {"exchange": exchange_key})
            self._market_status_cache[cache_key] = (time.time(), payload)
            return {"status": True, "data": payload, "meta": {"cached": False, "ageSeconds": 0}}

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def company_news(
        self,
        symbol: str,
        *,
        days: int = 30,
        refresh: bool = False,
        notify: bool = False,
    ) -> dict[str, Any]:
        ticker = finnhub_ticker(symbol)
        to_date = date.today()
        from_date = to_date - timedelta(days=days)
        cache_key = _company_cache_key(ticker, days)
        entry = self.store.get_cache(cache_key)

        if entry and _is_fresh(entry) and not refresh:
            return self._company_response(ticker, from_date, to_date, entry, cached=True)

        async with self._lock_for(cache_key):
            entry = self.store.get_cache(cache_key)
            if entry and _is_fresh(entry) and not refresh:
                return self._company_response(ticker, from_date, to_date, entry, cached=True)

            try:
                items = await _finnhub_get(
                    "/company-news",
                    {
                        "symbol": ticker,
                        "from": from_date.isoformat(),
                        "to": to_date.isoformat(),
                    },
                )
            except HTTPException:
                if entry:
                    return self._company_response(
                        ticker,
                        from_date,
                        to_date,
                        entry,
                        cached=True,
                        stale=True,
                    )
                raise

            sorted_items = _sort_news(items)[: news_cache_max_items()]
            existing_ids = entry.item_ids if entry else set()
            updated = self.store.set_cache(
                cache_key=cache_key,
                scope="company",
                topic=ticker,
                days=days,
                items=sorted_items,
                fetched_at=time.time(),
            )
            notifications = []
            if notify and entry:
                notifications = self.store.insert_notifications(
                    scope="company",
                    topic=ticker,
                    items=sorted_items,
                    existing_item_ids=existing_ids,
                )

            response = self._company_response(ticker, from_date, to_date, updated, cached=False)
            response["notifications"] = notifications
            return response

    async def market_news(
        self,
        category: str,
        *,
        min_id: int = 0,
        refresh: bool = False,
    ) -> dict[str, Any]:
        category_key = category.strip().lower()
        if category_key not in MARKET_NEWS_CATEGORIES:
            allowed = ", ".join(sorted(MARKET_NEWS_CATEGORIES))
            raise HTTPException(status_code=400, detail=f"Invalid category. Allowed: {allowed}")

        cache_key = _market_cache_key(category_key)
        entry = self.store.get_cache(cache_key)

        should_refresh = refresh or min_id > 0
        if entry and _is_fresh(entry) and not should_refresh:
            return self._market_response(category_key, min_id, entry, cached=True)

        async with self._lock_for(cache_key):
            entry = self.store.get_cache(cache_key)
            if entry and _is_fresh(entry) and not should_refresh:
                return self._market_response(category_key, min_id, entry, cached=True)
            try:
                items = await _finnhub_get("/news", {"category": category_key, "minId": min_id})
            except HTTPException:
                if entry:
                    return self._market_response(category_key, min_id, entry, cached=True, stale=True)
                raise

            if min_id > 0 and entry:
                merged = {
                    _news_item_id(item): item
                    for item in entry.items
                    if _news_item_id(item) > 0
                }
                for item in items:
                    item_id = _news_item_id(item)
                    if item_id > 0:
                        merged[item_id] = item
                sorted_items = _sort_news(list(merged.values()))[: news_cache_max_items()]
            else:
                sorted_items = _sort_news(items)[: news_cache_max_items()]

            updated = self.store.set_cache(
                cache_key=cache_key,
                scope="market",
                topic=category_key,
                days=None,
                items=sorted_items,
                fetched_at=time.time(),
            )
            return self._market_response(category_key, min_id, updated, cached=False)

    @staticmethod
    def _company_response(
        ticker: str,
        from_date: date,
        to_date: date,
        entry: NewsCacheEntry,
        *,
        cached: bool,
        stale: bool = False,
    ) -> dict[str, Any]:
        items = entry.items[:NEWS_LIMIT]
        return {
            "status": True,
            "data": items,
            "meta": {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
                "count": len(items),
                "cached": cached,
                "stale": stale,
                "ageSeconds": _cache_age(entry),
            },
        }

    @staticmethod
    def _market_response(
        category: str,
        min_id: int,
        entry: NewsCacheEntry,
        *,
        cached: bool,
        stale: bool = False,
    ) -> dict[str, Any]:
        items = entry.items
        if min_id > 0:
            items = [
                item
                for item in items
                if _news_item_id(item) > min_id
            ]
        items = items[:NEWS_LIMIT]
        return {
            "status": True,
            "data": items,
            "meta": {
                "category": category,
                "minId": min_id,
                "count": len(items),
                "cached": cached,
                "stale": stale,
                "ageSeconds": _cache_age(entry),
            },
        }


_service: NewsService | None = None


def get_news_service() -> NewsService:
    global _service
    if _service is None:
        _service = NewsService()
    return _service
