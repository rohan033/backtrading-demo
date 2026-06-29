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
from control_plane.earnings_monitor import build_earnings_monitors
from control_plane.insider_store import get_insider_store
from control_plane.watchlist_store import get_watchlist_store

FINNHUB_BASE = "https://finnhub.io/api/v1"
FINNHUB_MARKET_STATUS_PATH = "/stock/market-status"
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
    url = f"{FINNHUB_BASE}{path}?{query}"

    def _fetch_json() -> tuple[int, str]:
        req = Request(url, headers={"User-Agent": "backtrading-demo"})
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
    if status_code == 401:
        raise HTTPException(status_code=502, detail="Finnhub API key invalid or lacks market-status access")
    if status_code == 404:
        raise HTTPException(
            status_code=502,
            detail=f"Finnhub market-status endpoint not found ({url.split('token=')[0]}…)",
        )
    if status_code >= 400:
        detail = body.strip() or f"Finnhub error ({status_code})"
        raise HTTPException(status_code=502, detail=detail)

    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Finnhub returned invalid JSON") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="Finnhub market-status returned unexpected payload")

    return payload


def market_status_cache_ttl_seconds() -> int:
    return max(15, int(os.getenv("MARKET_STATUS_CACHE_TTL_SECONDS", "60")))


def watchlist_earnings_cache_ttl_seconds() -> int:
    return max(60, int(os.getenv("WATCHLIST_EARNINGS_CACHE_TTL_SECONDS", "900")))


def watchlist_insider_cache_ttl_seconds() -> int:
    return max(30, int(os.getenv("WATCHLIST_INSIDER_CACHE_TTL_SECONDS", "120")))


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
        self._watchlist_earnings_cache: tuple[float, dict[str, Any]] | None = None
        self._watchlist_insider_cache: tuple[float, dict[str, Any]] | None = None

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

            payload = await _finnhub_get_object(
                FINNHUB_MARKET_STATUS_PATH,
                {"exchange": exchange_key},
            )
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

    async def sec_filings(
        self,
        symbol: str,
        *,
        form: str | None = None,
        days: int = 365,
        limit: int = 40,
    ) -> dict[str, Any]:
        ticker = finnhub_ticker(symbol)
        to_date = date.today()
        from_date = to_date - timedelta(days=max(1, min(days, 730)))
        params: dict[str, str] = {
            "symbol": ticker,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
        }
        if form:
            params["form"] = form.strip()

        items = await _finnhub_get("/stock/filings", params)
        sorted_items = sorted(
            items,
            key=lambda row: str(row.get("filedDate") or row.get("acceptedDate") or ""),
            reverse=True,
        )[: max(1, min(limit, 100))]
        return {
            "status": True,
            "data": sorted_items,
            "meta": {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
                "count": len(sorted_items),
            },
        }

    async def filing_sentiment(self, access_number: str) -> dict[str, Any]:
        access = access_number.strip()
        if not access:
            raise HTTPException(status_code=400, detail="accessNumber is required")
        payload = await _finnhub_get_object(
            "/stock/filings-sentiment",
            {"accessNumber": access},
        )
        return {
            "status": True,
            "data": payload,
            "meta": {"accessNumber": access},
        }

    async def earnings_calendar(
        self,
        symbol: str,
        *,
        past_days: int = 90,
        future_days: int = 120,
    ) -> dict[str, Any]:
        ticker = finnhub_ticker(symbol)
        today = date.today()
        from_date = today - timedelta(days=max(1, min(past_days, 365)))
        to_date = today + timedelta(days=max(1, min(future_days, 365)))
        payload = await _finnhub_get_object(
            "/calendar/earnings",
            {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
            },
        )
        rows = payload.get("earningsCalendar") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            rows = []
        sorted_rows = sorted(
            rows,
            key=lambda row: str(row.get("date") or ""),
            reverse=True,
        )
        return {
            "status": True,
            "data": sorted_rows,
            "meta": {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
                "count": len(sorted_rows),
            },
        }

    async def watchlist_earnings(
        self,
        *,
        past_days: int = 14,
        future_days: int = 90,
        request_delay_seconds: float = 0.8,
        refresh: bool = False,
    ) -> dict[str, Any]:
        cache_key = f"{past_days}:{future_days}"
        ttl = watchlist_earnings_cache_ttl_seconds()
        cached = self._watchlist_earnings_cache
        if (
            cached
            and not refresh
            and (time.time() - cached[0]) < ttl
            and cached[1].get("meta", {}).get("cacheKey") == cache_key
        ):
            payload = dict(cached[1])
            meta = dict(payload.get("meta") or {})
            meta["cached"] = True
            meta["ageSeconds"] = round(time.time() - cached[0], 1)
            payload["meta"] = meta
            return payload

        ticker_refs: dict[str, list[dict[str, Any]]] = {}
        for watchlist in get_watchlist_store().list_watchlists():
            for symbol in watchlist.get("symbols") or []:
                raw = symbol.get("tradingsymbol") or symbol.get("symbol") or ""
                ticker = finnhub_ticker(str(raw))
                if not ticker:
                    continue
                ticker_refs.setdefault(ticker, []).append(
                    {
                        "tradingsymbol": symbol.get("tradingsymbol") or symbol.get("symbol"),
                        "symboltoken": symbol.get("symboltoken"),
                        "watchlistId": watchlist.get("id"),
                        "broker": watchlist.get("broker"),
                        "accountEnv": watchlist.get("account_env"),
                    }
                )

        tickers = sorted(ticker_refs.keys())
        all_events: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        semaphore = asyncio.Semaphore(max(1, int(os.getenv("WATCHLIST_EARNINGS_CONCURRENCY", "4"))))

        async def fetch_ticker(ticker: str) -> None:
            async with semaphore:
                try:
                    result = await self.earnings_calendar(
                        ticker,
                        past_days=past_days,
                        future_days=future_days,
                    )
                except HTTPException as exc:
                    errors.append(
                        {
                            "symbol": ticker,
                            "status": exc.status_code,
                            "detail": exc.detail,
                        }
                    )
                    return
                except Exception as exc:
                    errors.append({"symbol": ticker, "detail": str(exc)})
                    return

                for row in result.get("data") or []:
                    if not isinstance(row, dict):
                        continue
                    all_events.append(
                        {
                            **row,
                            "finnhubSymbol": ticker,
                            "watchlistRefs": ticker_refs[ticker],
                        }
                    )

        await asyncio.gather(*(fetch_ticker(ticker) for ticker in tickers))

        all_events.sort(key=lambda row: str(row.get("date") or ""))
        monitors = build_earnings_monitors(all_events)
        payload = {
            "status": True,
            "data": all_events,
            "monitor": monitors,
            "meta": {
                "cacheKey": cache_key,
                "tickerCount": len(tickers),
                "eventCount": len(all_events),
                "pastDays": past_days,
                "futureDays": future_days,
                "errors": errors,
                "cached": False,
                "ageSeconds": 0,
            },
        }
        self._watchlist_earnings_cache = (time.time(), payload)
        return payload

    async def insider_transactions(
        self,
        symbol: str,
        *,
        days: int = 90,
    ) -> dict[str, Any]:
        ticker = finnhub_ticker(symbol)
        to_date = date.today()
        from_date = to_date - timedelta(days=max(1, min(days, 365)))
        payload = await _finnhub_get_object(
            "/stock/insider-transactions",
            {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
            },
        )
        rows = payload.get("data") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            rows = []
        sorted_rows = sorted(
            rows,
            key=lambda row: str(row.get("transactionDate") or row.get("filingDate") or ""),
            reverse=True,
        )[:100]
        return {
            "status": True,
            "data": sorted_rows,
            "meta": {
                "symbol": ticker,
                "from": from_date.isoformat(),
                "to": to_date.isoformat(),
                "count": len(sorted_rows),
            },
        }

    def _watchlist_ticker_refs(self) -> dict[str, list[dict[str, Any]]]:
        ticker_refs: dict[str, list[dict[str, Any]]] = {}
        for watchlist in get_watchlist_store().list_watchlists():
            for symbol in watchlist.get("symbols") or []:
                raw = symbol.get("tradingsymbol") or symbol.get("symbol") or ""
                ticker = finnhub_ticker(str(raw))
                if not ticker:
                    continue
                ticker_refs.setdefault(ticker, []).append(
                    {
                        "tradingsymbol": symbol.get("tradingsymbol") or symbol.get("symbol"),
                        "symboltoken": symbol.get("symboltoken"),
                        "watchlistId": watchlist.get("id"),
                        "broker": watchlist.get("broker"),
                        "accountEnv": watchlist.get("account_env"),
                    }
                )
        return ticker_refs

    def watchlist_insider_transactions(
        self,
        *,
        symbol: str | None = None,
        days: int = 90,
        limit: int = 500,
        refresh: bool = False,
    ) -> dict[str, Any]:
        cache_key = f"{symbol or '*'}:{days}:{limit}"
        ttl = watchlist_insider_cache_ttl_seconds()
        cached = self._watchlist_insider_cache
        if (
            cached
            and not refresh
            and (time.time() - cached[0]) < ttl
            and cached[1].get("meta", {}).get("cacheKey") == cache_key
        ):
            payload = dict(cached[1])
            meta = dict(payload.get("meta") or {})
            meta["cached"] = True
            meta["ageSeconds"] = round(time.time() - cached[0], 1)
            payload["meta"] = meta
            return payload

        ticker_refs = self._watchlist_ticker_refs()
        ticker_filter = finnhub_ticker(symbol) if symbol else None
        rows = get_insider_store().list_transactions(
            symbol=ticker_filter,
            days=days,
            limit=limit,
        )
        enriched: list[dict[str, Any]] = []
        for row in rows:
            ticker = str(row.get("symbol") or "").upper()
            refs = ticker_refs.get(ticker) or []
            if ticker_refs and not refs:
                continue
            enriched.append({**row, "finnhubSymbol": ticker, "watchlistRefs": refs})

        payload = {
            "status": True,
            "data": enriched,
            "meta": {
                "cacheKey": cache_key,
                "tickerCount": len(ticker_refs),
                "transactionCount": len(enriched),
                "days": days,
                "lastPolledAt": get_insider_store().last_polled_at(),
                "cached": False,
                "ageSeconds": 0,
            },
        }
        self._watchlist_insider_cache = (time.time(), payload)
        return payload

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
