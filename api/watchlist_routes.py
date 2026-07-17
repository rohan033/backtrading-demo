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
    internal_asset_class_name: str | None = None
    instrument_display_name: str | None = None
    logo35x35: str | None = None
    logo50x50: str | None = None
    logo150x150: str | None = None
    raw_metadata: dict | None = None


def _metadata_from_etoro_record(record: dict | None) -> dict:
    if not isinstance(record, dict):
        return {}
    return {
        "internal_asset_class_name": record.get("internalAssetClassName") or record.get("internal_asset_class_name"),
        "instrument_display_name": (
            record.get("internalInstrumentDisplayName")
            or record.get("instrumentDisplayName")
            or record.get("instrument_display_name")
            or record.get("displayName")
        ),
        "logo35x35": record.get("logo35x35"),
        "logo50x50": record.get("logo50x50"),
        "logo150x150": record.get("logo150x150"),
    }


async def _fill_missing_etoro_metadata(req: AddSymbolRequest, account_env: str) -> dict:
    metadata = {
        "internal_asset_class_name": req.internal_asset_class_name,
        "instrument_display_name": req.instrument_display_name,
        "logo35x35": req.logo35x35,
        "logo50x50": req.logo50x50,
        "logo150x150": req.logo150x150,
    }
    raw = req.raw_metadata if isinstance(req.raw_metadata, dict) else None
    for key, value in _metadata_from_etoro_record(raw).items():
        metadata[key] = metadata.get(key) or value
    if metadata.get("logo35x35") or metadata.get("logo50x50") or metadata.get("logo150x150"):
        return metadata

    try:
        instrument_id = int(req.symboltoken)
    except (TypeError, ValueError):
        return metadata

    try:
        from brokers.etoro.trading_client import EtoroTradingClient

        env = "demo" if (account_env or "demo").lower() == "demo" else "live"
        client = EtoroTradingClient(account_env=env)
        client.generate_session()
        records = await client.aget_instrument_display_data([instrument_id])
    except Exception:
        return metadata

    if records:
        display_metadata = _metadata_from_etoro_record(records[0])
        for key, value in display_metadata.items():
            metadata[key] = metadata.get(key) or value
        if raw is None:
            req.raw_metadata = records[0]
    return metadata


@router.get("", operation_id="list_watchlists", summary="List all watchlists")
def list_watchlists():
    store = get_watchlist_store()
    # Refresh the auto-maintained "Past Traded" watchlist so it shows up in
    # Watch & Trade as soon as the panel loads. Local-only + best-effort.
    try:
        from control_plane.past_traded_sync import sync_past_traded_watchlist

        for env in ("demo", "live"):
            sync_past_traded_watchlist(broker="etoro", account_env=env)
    except Exception:
        pass
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
async def add_watchlist_symbol(watchlist_id: str, req: AddSymbolRequest):
    store = get_watchlist_store()
    watchlist = store.get_watchlist(watchlist_id)
    if not watchlist:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    metadata = {}
    if (watchlist.get("broker") or "").lower() == "etoro":
        metadata = await _fill_missing_etoro_metadata(req, watchlist.get("account_env") or "demo")
    row = store.add_symbol(
        watchlist_id,
        symboltoken=req.symboltoken,
        tradingsymbol=req.tradingsymbol,
        exchange=req.exchange,
        symbol=req.symbol,
        internal_asset_class_name=metadata.get("internal_asset_class_name") or req.internal_asset_class_name,
        instrument_display_name=metadata.get("instrument_display_name") or req.instrument_display_name,
        logo35x35=metadata.get("logo35x35") or req.logo35x35,
        logo50x50=metadata.get("logo50x50") or req.logo50x50,
        logo150x150=metadata.get("logo150x150") or req.logo150x150,
        raw_metadata=req.raw_metadata,
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
