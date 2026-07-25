"""Yahoo Finance extended-hours quote API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from control_plane.yahoo_finance_service import YahooRateLimitError, get_yahoo_finance_service

router = APIRouter(prefix="/api/yahoo-finance", tags=["yahoo-finance"])


@router.get(
    "/quote",
    operation_id="get_yahoo_finance_quote",
    summary="Extended-hours quote from Yahoo Finance chart API",
)
async def get_yahoo_finance_quote(
    ticker: str = Query(..., min_length=1, max_length=32, description="Symbol or EXCHANGE:SYMBOL"),
):
    try:
        data = await get_yahoo_finance_service().quote(ticker)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except YahooRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=str(exc) or "Yahoo Finance request failed",
        ) from exc
    return {"status": True, "data": data}
