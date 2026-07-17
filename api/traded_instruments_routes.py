from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.traded_instruments_store import get_traded_instruments_store

router = APIRouter(prefix="/api/traded-instruments", tags=["traded-instruments"])


class RecordTradedInstrumentRequest(BaseModel):
    symboltoken: str
    tradingsymbol: str
    broker: str = Field(default="etoro")
    account_env: str = Field(default="demo")
    exchange: str = Field(default="ETORO")
    symbol: str | None = None
    internal_asset_class_name: str | None = None
    instrument_display_name: str | None = None
    logo35x35: str | None = None
    logo50x50: str | None = None
    logo150x150: str | None = None
    raw_metadata: dict | None = None
    position_id: str | None = None
    side: str | None = None
    bump_trade_count: bool = True


@router.get("", operation_id="list_traded_instruments", summary="List past-traded instruments")
def list_traded_instruments(broker: str | None = None, account_env: str | None = None):
    store = get_traded_instruments_store()
    return {
        "status": True,
        "data": store.list_instruments(broker=broker, account_env=account_env),
    }


@router.post("", operation_id="record_traded_instrument", summary="Record/upsert a traded instrument")
def record_traded_instrument(req: RecordTradedInstrumentRequest):
    store = get_traded_instruments_store()
    row = store.upsert(
        symboltoken=req.symboltoken,
        tradingsymbol=req.tradingsymbol,
        broker=req.broker,
        account_env=req.account_env,
        exchange=req.exchange,
        symbol=req.symbol,
        internal_asset_class_name=req.internal_asset_class_name,
        instrument_display_name=req.instrument_display_name,
        logo35x35=req.logo35x35,
        logo50x50=req.logo50x50,
        logo150x150=req.logo150x150,
        raw_metadata=req.raw_metadata,
        position_id=req.position_id,
        side=req.side,
        bump_trade_count=req.bump_trade_count,
    )
    if not row:
        raise HTTPException(status_code=400, detail="symboltoken and tradingsymbol are required")
    return {"status": True, "data": row}


@router.delete(
    "/{symboltoken}",
    operation_id="delete_traded_instrument",
    summary="Remove an instrument from the past-traded registry",
)
def delete_traded_instrument(symboltoken: str, broker: str = "etoro", account_env: str = "demo"):
    store = get_traded_instruments_store()
    if not store.remove(broker=broker, account_env=account_env, symboltoken=symboltoken):
        raise HTTPException(status_code=404, detail="Instrument not found")
    return {"status": True}
