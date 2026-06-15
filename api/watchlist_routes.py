from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.watchlist_store import get_watchlist_store

router = APIRouter(prefix="/api/watchlists", tags=["watchlists"])


class CreateWatchlistRequest(BaseModel):
    name: str = Field(default="Watchlist", max_length=80)
    broker: str = Field(default="angel")
    account_env: str | None = None
    panel_id: str | None = None


class UpdateWatchlistRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    broker: str | None = None
    account_env: str | None = None
    panel_id: str | None = None


class RenameWatchlistRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class AddSymbolRequest(BaseModel):
    symboltoken: str
    tradingsymbol: str
    exchange: str = "NSE"
    symbol: str | None = None


@router.get("", operation_id="list_watchlists", summary="List all watchlists")
def list_watchlists():
    store = get_watchlist_store()
    return {"status": True, "data": store.list_watchlists()}


@router.post("", operation_id="create_watchlist", summary="Create a watchlist")
def create_watchlist(req: CreateWatchlistRequest):
    store = get_watchlist_store()
    row = store.create_watchlist(
        req.name,
        broker=req.broker,
        account_env=req.account_env,
        panel_id=req.panel_id,
    )
    return {"status": True, "data": row}


@router.patch("/{watchlist_id}", operation_id="update_watchlist", summary="Update watchlist settings")
def update_watchlist(watchlist_id: str, req: UpdateWatchlistRequest):
    store = get_watchlist_store()
    row = store.update_watchlist(
        watchlist_id,
        name=req.name,
        broker=req.broker,
        account_env=req.account_env,
        panel_id=req.panel_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    return {"status": True, "data": row}


@router.patch("/{watchlist_id}/rename", operation_id="rename_watchlist", summary="Rename a watchlist")
def rename_watchlist(watchlist_id: str, req: RenameWatchlistRequest):
    store = get_watchlist_store()
    row = store.rename_watchlist(watchlist_id, req.name)
    if not row:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    return {"status": True, "data": row}


@router.delete("/{watchlist_id}", operation_id="delete_watchlist", summary="Delete a watchlist")
def delete_watchlist(watchlist_id: str):
    store = get_watchlist_store()
    if not store.delete_watchlist(watchlist_id):
        raise HTTPException(status_code=404, detail="Watchlist not found")
    return {"status": True}


@router.post("/{watchlist_id}/symbols", operation_id="add_watchlist_symbol", summary="Add symbol to watchlist")
def add_watchlist_symbol(watchlist_id: str, req: AddSymbolRequest):
    store = get_watchlist_store()
    row = store.add_symbol(
        watchlist_id,
        symboltoken=req.symboltoken,
        tradingsymbol=req.tradingsymbol,
        exchange=req.exchange,
        symbol=req.symbol,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    return {"status": True, "data": row}


@router.delete(
    "/{watchlist_id}/symbols/{symboltoken}",
    operation_id="remove_watchlist_symbol",
    summary="Remove symbol from watchlist",
)
def remove_watchlist_symbol(watchlist_id: str, symboltoken: str):
    store = get_watchlist_store()
    row = store.remove_symbol(watchlist_id, symboltoken)
    if not row:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    return {"status": True, "data": row}
