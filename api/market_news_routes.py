"""Finnhub company news proxy (keeps API key server-side)."""

from __future__ import annotations

import os
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import json

router = APIRouter(prefix="/api/market", tags=["market"])

FINNHUB_BASE = "https://finnhub.io/api/v1"
NEWS_LIMIT = 20
MARKET_NEWS_CATEGORIES = frozenset({"general", "forex", "crypto", "merger"})


async def _finnhub_get(path: str, params: dict[str, str | int]) -> list:
    token = os.getenv("FINNHUB_API_KEY", "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="FINNHUB_API_KEY is not configured")

    query = urlencode({**params, "token": token})

    def _fetch_json():
        req = Request(f"{FINNHUB_BASE}{path}?{query}", headers={"User-Agent": "backtrading-demo"})
        with urlopen(req, timeout=15) as resp:
            status = getattr(resp, "status", 200)
            body = resp.read().decode("utf-8")
        return status, body

    try:
        import asyncio

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


def finnhub_ticker(tradingsymbol: str) -> str:
    """Map watchlist tradingsymbol to a Finnhub US ticker."""
    symbol = tradingsymbol.strip().upper()
    for suffix in ("-EQ", "-BE", "-SM", "-BZ", "-BL"):
        if symbol.endswith(suffix):
            symbol = symbol[: -len(suffix)]
            break
    if "." in symbol:
        symbol = symbol.split(".", 1)[0]
    return symbol


@router.get(
    "/company-news",
    operation_id="get_company_news",
    summary="Recent company news for a symbol (Finnhub, North American stocks)",
)
async def get_company_news(
    symbol: str = Query(..., min_length=1, max_length=32),
    days: int = Query(30, ge=1, le=90),
):
    ticker = finnhub_ticker(symbol)
    to_date = date.today()
    from_date = to_date - timedelta(days=days)

    items = await _finnhub_get(
        "/company-news",
        {
            "symbol": ticker,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
        },
    )
    items.sort(key=lambda row: int(row.get("datetime") or 0), reverse=True)

    return {
        "status": True,
        "data": items[:NEWS_LIMIT],
        "meta": {
            "symbol": ticker,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
            "count": min(len(items), NEWS_LIMIT),
        },
    }


@router.get(
    "/market-news",
    operation_id="get_market_news",
    summary="Latest market news by category (Finnhub)",
)
async def get_market_news(
    category: str = Query("general"),
    min_id: int = Query(0, ge=0, alias="minId"),
):
    category_key = category.strip().lower()
    if category_key not in MARKET_NEWS_CATEGORIES:
        allowed = ", ".join(sorted(MARKET_NEWS_CATEGORIES))
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Allowed: {allowed}",
        )

    items = await _finnhub_get("/news", {"category": category_key, "minId": min_id})
    items.sort(key=lambda row: int(row.get("datetime") or 0), reverse=True)

    return {
        "status": True,
        "data": items[:NEWS_LIMIT],
        "meta": {
            "category": category_key,
            "minId": min_id,
            "count": min(len(items), NEWS_LIMIT),
        },
    }
