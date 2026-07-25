"""Fetch extended-hours quotes from Yahoo Finance chart API."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any

import httpx

log = logging.getLogger("backtrading")

YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
YAHOO_CHART_INTERVAL = "5m"
YAHOO_CHART_RANGE = "1d"
YAHOO_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
YAHOO_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": YAHOO_USER_AGENT,
    "Referer": "https://finance.yahoo.com/",
}
CACHE_TTL_SEC = 120.0
STALE_CACHE_TTL_SEC = 900.0
MIN_YAHOO_REQUEST_INTERVAL_SEC = 3.0

_quote_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_yahoo_lock = asyncio.Lock()
_last_yahoo_request_at = 0.0
_inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}


class YahooRateLimitError(RuntimeError):
    """Yahoo Finance rejected the request (HTTP 429)."""


def normalize_yahoo_ticker(ticker: str) -> str:
    text = str(ticker or "").strip().upper()
    if not text:
        return ""
    if ":" in text:
        text = text.split(":", 1)[1]
    if text.endswith(".US"):
        text = text[:-3]
    return text.replace("/", "-")


def _safe_num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _cache_get(key: str, *, allow_stale: bool = False) -> dict[str, Any] | None:
    cached = _quote_cache.get(key)
    if not cached:
        return None
    age = time.time() - cached[0]
    if age <= CACHE_TTL_SEC:
        return dict(cached[1])
    if allow_stale and age <= STALE_CACHE_TTL_SEC:
        stale = dict(cached[1])
        stale["stale"] = True
        return stale
    return None


def _cache_put(key: str, payload: dict[str, Any]) -> None:
    _quote_cache[key] = (time.time(), payload)


def _find_index(timestamps: list[int], boundary: int | None) -> int:
    if boundary is None:
        return 0
    for idx, ts in enumerate(timestamps):
        if ts >= boundary:
            return idx
    return len(timestamps)


def _slice_extrema(
    highs: list[Any],
    lows: list[Any],
    start: int,
    end: int,
) -> tuple[float | None, float | None]:
    hi_values: list[float] = []
    lo_values: list[float] = []
    for i in range(start, min(end, len(highs))):
        hi = _safe_num(highs[i])
        if hi is not None:
            hi_values.append(hi)
    for i in range(start, min(end, len(lows))):
        lo = _safe_num(lows[i])
        if lo is not None:
            lo_values.append(lo)
    return (
        max(hi_values) if hi_values else None,
        min(lo_values) if lo_values else None,
    )


def _last_close_in_range(
    closes: list[Any],
    timestamps: list[int],
    start: int | None,
    end: int | None,
) -> float | None:
    idx_start = _find_index(timestamps, start)
    idx_end = _find_index(timestamps, end)
    for idx in range(min(idx_end, len(closes)) - 1, idx_start - 1, -1):
        price = _safe_num(closes[idx])
        if price is not None:
            return price
    return None


def _session_from_timestamp(
    last_ts: int,
    *,
    pre: dict[str, Any],
    regular: dict[str, Any],
    post: dict[str, Any],
) -> str:
    pre_start = pre.get("start")
    pre_end = pre.get("end")
    reg_start = regular.get("start")
    reg_end = regular.get("end")
    post_start = post.get("start")
    post_end = post.get("end")

    if pre_start is not None and pre_end is not None and pre_start <= last_ts <= pre_end:
        return "PRE"
    if reg_start is not None and reg_end is not None and reg_start <= last_ts <= reg_end:
        return "REG"
    if post_start is not None and post_end is not None and post_start <= last_ts <= post_end:
        return "POST"
    return "CLOSED"


def parse_yahoo_chart_payload(ticker: str, payload: dict[str, Any]) -> dict[str, Any]:
    chart = payload.get("chart") or {}
    error = chart.get("error")
    if error:
        description = error.get("description") or error.get("code") or "Yahoo Finance chart error"
        raise ValueError(str(description))

    results = chart.get("result") or []
    if not results:
        raise ValueError("Yahoo Finance returned no chart result")

    result = results[0]
    meta = result.get("meta") or {}
    timestamps = [int(ts) for ts in (result.get("timestamp") or []) if ts is not None]
    if not timestamps:
        raise ValueError("Yahoo Finance returned no timestamps")

    quote_rows = (result.get("indicators") or {}).get("quote") or []
    quote = quote_rows[0] if quote_rows else {}
    closes = quote.get("close") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []

    periods = meta.get("currentTradingPeriod") or {}
    pre = periods.get("pre") or {}
    regular = periods.get("regular") or {}
    post = periods.get("post") or {}

    last_ts = timestamps[-1]
    session = _session_from_timestamp(last_ts, pre=pre, regular=regular, post=post)
    previous_close = _safe_num(meta.get("chartPreviousClose") or meta.get("previousClose"))

    reg_start_idx = _find_index(timestamps, regular.get("start"))
    reg_end_idx = _find_index(timestamps, regular.get("end"))

    price: float | None = None
    high: float | None = None
    low: float | None = None

    if session == "PRE":
        price = _last_close_in_range(closes, timestamps, pre.get("start"), pre.get("end"))
        if price is None:
            price = _safe_num(meta.get("preMarketPrice") or meta.get("regularMarketPrice"))
        high, low = _slice_extrema(highs, lows, _find_index(timestamps, pre.get("start")), reg_start_idx)
    elif session == "POST":
        price = _last_close_in_range(closes, timestamps, post.get("start"), post.get("end"))
        if price is None:
            price = _safe_num(meta.get("postMarketPrice") or meta.get("regularMarketPrice"))
        high, low = _slice_extrema(highs, lows, reg_end_idx, len(timestamps))
    else:
        price = _safe_num(meta.get("regularMarketPrice") or meta.get("previousClose"))
        high, low = _slice_extrema(highs, lows, reg_start_idx, reg_end_idx)

    change: float | None = None
    change_pct: float | None = None
    if price is not None and previous_close is not None and previous_close != 0:
        change = price - previous_close
        change_pct = (change / previous_close) * 100.0

    direction = "flat"
    if change is not None:
        if change > 0:
            direction = "up"
        elif change < 0:
            direction = "down"

    return {
        "ticker": normalize_yahoo_ticker(ticker) or ticker,
        "yahoo_symbol": normalize_yahoo_ticker(ticker),
        "session": session,
        "extended_hours": session in {"PRE", "POST"},
        "previous_close": previous_close,
        "price": price,
        "change": round(change, 4) if change is not None else None,
        "change_pct": round(change_pct, 4) if change_pct is not None else None,
        "direction": direction,
        "high": high,
        "low": low,
        "currency": meta.get("currency"),
        "exchange_timezone": meta.get("exchangeTimezoneName"),
        "market_state": meta.get("marketState"),
        "interval": YAHOO_CHART_INTERVAL,
        "range": YAHOO_CHART_RANGE,
        "stale": False,
    }


async def _throttled_yahoo_get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    global _last_yahoo_request_at
    async with _yahoo_lock:
        now = time.time()
        wait = MIN_YAHOO_REQUEST_INTERVAL_SEC - (now - _last_yahoo_request_at)
        if wait > 0:
            await asyncio.sleep(wait)
        response = await client.get(url, headers=YAHOO_HEADERS)
        _last_yahoo_request_at = time.time()
        return response


async def _fetch_yahoo_chart_impl(ticker: str) -> dict[str, Any]:
    symbol = normalize_yahoo_ticker(ticker)
    if not symbol:
        raise ValueError("Ticker is required")

    cache_key = symbol.upper()
    fresh = _cache_get(cache_key)
    if fresh is not None:
        return fresh

    url = (
        f"{YAHOO_CHART_BASE}/{symbol}"
        f"?includePrePost=true&interval={YAHOO_CHART_INTERVAL}&range={YAHOO_CHART_RANGE}"
    )
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        response = await _throttled_yahoo_get(client, url)

    if response.status_code == 429:
        stale = _cache_get(cache_key, allow_stale=True)
        if stale is not None:
            log.warning("[YAHOO] rate limited symbol=%s — serving stale cache", symbol)
            return stale
        raise YahooRateLimitError("Yahoo Finance rate limited; retry later")

    try:
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as exc:
        stale = _cache_get(cache_key, allow_stale=True)
        if stale is not None:
            log.warning("[YAHOO] upstream %s symbol=%s — serving stale cache", exc.response.status_code, symbol)
            return stale
        raise ValueError(f"Yahoo Finance HTTP {exc.response.status_code}") from exc
    except Exception as exc:
        stale = _cache_get(cache_key, allow_stale=True)
        if stale is not None:
            log.warning("[YAHOO] parse/upstream error symbol=%s — serving stale cache: %s", symbol, exc)
            return stale
        raise

    parsed = parse_yahoo_chart_payload(ticker, payload)
    _cache_put(cache_key, parsed)
    return parsed


async def fetch_yahoo_chart(ticker: str) -> dict[str, Any]:
    symbol = normalize_yahoo_ticker(ticker)
    if not symbol:
        raise ValueError("Ticker is required")
    cache_key = symbol.upper()

    inflight = _inflight.get(cache_key)
    if inflight is not None:
        return dict(await inflight)

    task = asyncio.create_task(_fetch_yahoo_chart_impl(ticker))
    _inflight[cache_key] = task
    try:
        return await task
    finally:
        if _inflight.get(cache_key) is task:
            _inflight.pop(cache_key, None)


def get_yahoo_finance_service() -> "YahooFinanceService":
    return YahooFinanceService()


class YahooFinanceService:
    async def quote(self, ticker: str) -> dict[str, Any]:
        return await fetch_yahoo_chart(ticker)
