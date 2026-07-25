"""TradingView screener CRUD, refresh, and eToro watchlist sync."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.screener_fields import list_screener_fields
from control_plane.screener_query import (
    ScreenerDefinition,
    ScreenerQueryError,
    definition_to_dsl,
    parse_dsl,
    run_scanner,
)
from control_plane.screener_store import get_screener_store
from control_plane.screener_watchlist_sync import sync_screener_to_watchlist
from control_plane.stock_catalyst_screener import (
    STOCK_CATALYST_SOURCE_TYPES,
    run_stock_catalyst_screener,
)

router = APIRouter(prefix="/api/screeners", tags=["screeners"])


class CreateScreenerRequest(BaseModel):
    name: str = Field(default="Screener", max_length=80)
    definition: dict[str, Any] | None = None
    dsl_text: str | None = None
    auto_refresh_seconds: int = Field(default=0, ge=0, le=3600)


class UpdateScreenerRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    definition: dict[str, Any] | None = None
    dsl_text: str | None = None
    auto_refresh_seconds: int | None = Field(default=None, ge=0, le=3600)


class ValidateDslRequest(BaseModel):
    dsl_text: str = Field(..., min_length=1)


class GenerateScreenerRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    create: bool = False
    model_id: str | None = None
    model_params: list[dict[str, str]] = Field(default_factory=list)


class SyncWatchlistRequest(BaseModel):
    tickers: list[str] | None = None
    account_env: str = Field(default="demo")
    instrument_overrides: dict[str, int] | None = None


def _http_query_error(exc: ScreenerQueryError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/fields", operation_id="list_screener_fields", summary="List screener field catalog")
def get_fields():
    return {"status": True, "data": list_screener_fields()}


@router.get(
    "/presets",
    operation_id="list_screener_presets",
    summary="List built-in screener presets (1% / Agent Mode queries)",
)
def list_presets():
    from control_plane.screener_query import ONE_PERCENT_PRESET_UI_KEYS, ONE_PERCENT_QUERY_PRESETS

    rows = []
    for key in ONE_PERCENT_PRESET_UI_KEYS:
        preset = ONE_PERCENT_QUERY_PRESETS.get(key) or {}
        definition = preset.get("definition")
        defn = definition.to_dict() if hasattr(definition, "to_dict") else None
        rows.append({
            "key": key,
            "name": preset.get("name") or key,
            "description": preset.get("description") or "",
            "phase": preset.get("phase") or "regular",
            "definition": defn,
        })
    return {"status": True, "data": rows}


@router.post("/validate", operation_id="validate_screener_dsl", summary="Validate screener DSL")
def validate_dsl(req: ValidateDslRequest):
    try:
        defn = parse_dsl(req.dsl_text)
    except ScreenerQueryError as exc:
        raise _http_query_error(exc) from exc
    return {
        "status": True,
        "data": {
            "definition": defn.to_dict(),
            "dsl_text": definition_to_dsl(defn),
        },
    }


@router.post(
    "/generate",
    operation_id="generate_screener_from_text",
    summary="AI agent: free-text → screener definition (optionally create)",
)
async def generate_screener(req: GenerateScreenerRequest):
    from control_plane.screener_ai_generate import generate_screener_from_text

    try:
        generated = await generate_screener_from_text(
            req.prompt,
            model_id=req.model_id,
            model_params=req.model_params or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=str(exc) or "AI screener generation failed",
        ) from exc

    screener = None
    if req.create:
        store = get_screener_store()
        screener = store.create_screener(
            name=generated["name"],
            definition=generated["definition"],
            dsl_text=generated["dsl_text"],
        )
    return {
        "status": True,
        "data": {
            **generated,
            "screener": screener,
        },
    }


@router.get("", operation_id="list_screeners", summary="List screeners")
def list_screeners(include_results: bool = False):
    store = get_screener_store()
    return {"status": True, "data": store.list_screeners(include_results=include_results)}


@router.get("/{screener_id}", operation_id="get_screener", summary="Get screener with results")
def get_screener(screener_id: str):
    store = get_screener_store()
    row = store.get_screener(screener_id)
    if not row:
        raise HTTPException(status_code=404, detail="Screener not found")
    return {"status": True, "data": row}


@router.post("", operation_id="create_screener", summary="Create a screener")
def create_screener(req: CreateScreenerRequest):
    store = get_screener_store()
    try:
        row = store.create_screener(
            req.name,
            definition=req.definition,
            dsl_text=req.dsl_text,
            auto_refresh_seconds=req.auto_refresh_seconds,
        )
    except ScreenerQueryError as exc:
        raise _http_query_error(exc) from exc
    return {"status": True, "data": row}


@router.patch("/{screener_id}", operation_id="update_screener", summary="Update a screener")
def update_screener(screener_id: str, req: UpdateScreenerRequest):
    store = get_screener_store()
    try:
        row = store.update_screener(
            screener_id,
            name=req.name,
            definition=req.definition,
            dsl_text=req.dsl_text,
            auto_refresh_seconds=req.auto_refresh_seconds,
        )
    except ScreenerQueryError as exc:
        raise _http_query_error(exc) from exc
    if not row:
        raise HTTPException(status_code=404, detail="Screener not found")
    return {"status": True, "data": row}


@router.delete("/{screener_id}", operation_id="delete_screener", summary="Delete a screener")
def delete_screener(screener_id: str):
    store = get_screener_store()
    if not store.delete_screener(screener_id):
        raise HTTPException(status_code=404, detail="Screener not found")
    return {"status": True}


@router.post(
    "/{screener_id}/refresh",
    operation_id="refresh_screener",
    summary="Refresh screener results",
)
async def refresh_screener(screener_id: str):
    store = get_screener_store()
    screener = store.get_screener(screener_id, include_results=False)
    if not screener:
        raise HTTPException(status_code=404, detail="Screener not found")

    store.set_refresh_status(screener_id, "running", error=None)
    try:
        source_type = screener.get("source_type") or "tradingview"
        if source_type in STOCK_CATALYST_SOURCE_TYPES:
            total, rows, _columns = await asyncio.to_thread(
                run_stock_catalyst_screener,
                screener.get("source_url") or None,
            )
        else:
            defn = ScreenerDefinition.from_dict(screener.get("definition") or {})
            total, rows, _columns = await asyncio.to_thread(run_scanner, defn)
        updated = store.replace_results(screener_id, rows=rows, total_count=total)
        return {"status": True, "data": updated}
    except ScreenerQueryError as exc:
        store.mark_refresh_failed(screener_id, str(exc))
        raise _http_query_error(exc) from exc
    except Exception as exc:
        message = str(exc) or "Screener source request failed"
        updated = store.mark_refresh_failed(screener_id, message)
        raise HTTPException(status_code=502, detail=message) from exc


@router.post(
    "/{screener_id}/watchlist",
    operation_id="sync_screener_watchlist",
    summary="Add screener symbols to eToro watchlist",
)
async def sync_watchlist(screener_id: str, req: SyncWatchlistRequest):
    store = get_screener_store()
    if not store.get_screener(screener_id, include_results=False):
        raise HTTPException(status_code=404, detail="Screener not found")
    try:
        summary = await sync_screener_to_watchlist(
            screener_id,
            tickers=req.tickers,
            account_env=req.account_env,
            instrument_overrides=req.instrument_overrides,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc) or "Watchlist sync failed") from exc
    # Return latest screener (with linked watchlist_id) + summary
    screener = store.get_screener(screener_id)
    return {"status": True, "data": {"screener": screener, "summary": summary}}
