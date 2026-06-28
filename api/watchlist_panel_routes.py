from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.watchlist_store import get_watchlist_store

router = APIRouter(prefix="/api/watchlist-panels", tags=["watchlist-panels"])


class CreatePanelRequest(BaseModel):
    name: str = Field(default="Panel", max_length=80)


class UpdatePanelRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    position: int | None = None


@router.get("", operation_id="list_watchlist_panels", summary="List watchlist panels")
def list_panels():
    store = get_watchlist_store()
    return {"status": True, "data": store.list_panels()}


@router.post("", operation_id="create_watchlist_panel", summary="Create a watchlist panel")
def create_panel(req: CreatePanelRequest):
    store = get_watchlist_store()
    row = store.create_panel(req.name)
    return {"status": True, "data": row}


@router.patch("/{panel_id}", operation_id="update_watchlist_panel", summary="Update a watchlist panel")
def update_panel(panel_id: str, req: UpdatePanelRequest):
    store = get_watchlist_store()
    row = store.update_panel(panel_id, name=req.name, position=req.position)
    if not row:
        raise HTTPException(status_code=404, detail="Panel not found")
    return {"status": True, "data": row}


@router.delete("/{panel_id}", operation_id="delete_watchlist_panel", summary="Delete a watchlist panel")
def delete_panel(panel_id: str):
    store = get_watchlist_store()
    if not store.delete_panel(panel_id):
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the last panel or panel not found",
        )
    return {"status": True}
