"""eToro stock search settings (legacy API vs Algolia)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.etoro_search_settings import get_etoro_search_settings_store

router = APIRouter(prefix="/api/etoro/search-settings", tags=["etoro-search"])


class EtoroSearchModeBody(BaseModel):
    mode: str = Field(..., description="legacy or algolia")


@router.get(
    "",
    operation_id="get_etoro_search_settings",
    summary="Current eToro stock search provider",
)
async def get_etoro_search_settings():
    store = get_etoro_search_settings_store()
    return {"status": True, "data": store.get_settings_payload()}


@router.put(
    "",
    operation_id="set_etoro_search_settings",
    summary="Set eToro stock search provider",
)
async def set_etoro_search_settings(body: EtoroSearchModeBody):
    store = get_etoro_search_settings_store()
    try:
        data = store.set_search_mode(body.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": True, "data": data}
