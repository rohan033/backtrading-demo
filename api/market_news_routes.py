"""Finnhub news endpoints backed by a compressed SQLite cache."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from control_plane.news_service import (
    MARKET_NEWS_CATEGORIES,
    get_news_service,
)
from control_plane.news_store import get_news_store

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get(
    "/company-news",
    operation_id="get_company_news",
    summary="Recent company news for a symbol (Finnhub, North American stocks)",
)
async def get_company_news(
    symbol: str = Query(..., min_length=1, max_length=32),
    days: int = Query(30, ge=1, le=90),
    refresh: bool = Query(False),
):
    return await get_news_service().company_news(symbol, days=days, refresh=refresh)


@router.get(
    "/market-news",
    operation_id="get_market_news",
    summary="Latest market news by category (Finnhub)",
)
async def get_market_news(
    category: str = Query("general"),
    min_id: int = Query(0, ge=0, alias="minId"),
    refresh: bool = Query(False),
):
    category_key = category.strip().lower()
    if category_key not in MARKET_NEWS_CATEGORIES:
        allowed = ", ".join(sorted(MARKET_NEWS_CATEGORIES))
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Allowed: {allowed}",
        )

    return await get_news_service().market_news(
        category_key,
        min_id=min_id,
        refresh=refresh,
    )


@router.get(
    "/news-notifications",
    operation_id="get_news_notifications",
    summary="Recent cached news notifications",
)
async def get_news_notifications(limit: int = Query(50, ge=1, le=200)):
    return {
        "status": True,
        "data": get_news_store().recent_notifications(limit=limit),
    }


@router.get(
    "/market-status",
    operation_id="get_market_status",
    summary="Market open status for an exchange (Finnhub)",
)
async def get_market_status(
    exchange: str = Query("US", min_length=1, max_length=16),
    refresh: bool = Query(False),
):
    return await get_news_service().market_status(exchange, refresh=refresh)


@router.get(
    "/filings",
    operation_id="get_sec_filings",
    summary="SEC filings for a symbol (Finnhub)",
)
async def get_sec_filings(
    symbol: str = Query(..., min_length=1, max_length=32),
    form: str | None = Query(None, max_length=32),
    days: int = Query(365, ge=1, le=730),
    limit: int = Query(40, ge=1, le=100),
):
    return await get_news_service().sec_filings(symbol, form=form, days=days, limit=limit)


@router.get(
    "/filings-sentiment",
    operation_id="get_filing_sentiment",
    summary="SEC filing sentiment for a report access number (Finnhub premium)",
)
async def get_filing_sentiment(
    access_number: str = Query(..., min_length=1, alias="accessNumber"),
):
    return await get_news_service().filing_sentiment(access_number)


@router.get(
    "/earnings-calendar",
    operation_id="get_earnings_calendar",
    summary="Historical and upcoming earnings for a symbol (Finnhub)",
)
async def get_earnings_calendar(
    symbol: str = Query(..., min_length=1, max_length=32),
    past_days: int = Query(90, ge=1, le=365, alias="pastDays"),
    future_days: int = Query(120, ge=1, le=365, alias="futureDays"),
):
    return await get_news_service().earnings_calendar(
        symbol,
        past_days=past_days,
        future_days=future_days,
    )
