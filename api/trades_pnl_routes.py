from __future__ import annotations

import csv
import io
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from control_plane.etoro_close_settle import settled_fields_from_closed_trade
from control_plane.trades_pnl_store import get_trades_pnl_store

router = APIRouter(prefix="/api/trades-pnl", tags=["trades-pnl"])
log = logging.getLogger("backtrading")

_CSV_COLUMNS = [
    "opened_at",
    "closed_at",
    "status",
    "source",
    "broker",
    "account_env",
    "tradingsymbol",
    "symbol",
    "symboltoken",
    "exchange",
    "side",
    "quantity",
    "capital",
    "entry_price",
    "exit_price",
    "take_profit_price",
    "stop_loss_price",
    "pnl",
    "pnl_pct",
    "close_reason",
    "execution_id",
    "order_id",
    "position_id",
]

_IMPORT_SOURCES = ("positions", "bracket", "momentum-trade", "manual")


@router.get("", operation_id="list_trades_pnl", summary="List recorded trades with P&L")
def list_trades_pnl(
    broker: str | None = None,
    account_env: str | None = None,
    status: str | None = None,
    limit: int = 1000,
):
    store = get_trades_pnl_store()
    trades = store.list_trades(
        broker=broker, account_env=account_env, status=status, limit=limit
    )
    return {
        "status": True,
        "data": trades,
        "summary": store.summary(broker=broker, account_env=account_env),
    }


@router.get("/report.csv", operation_id="download_trades_pnl_report", summary="Download trades P&L report as CSV")
def download_trades_pnl_report(
    broker: str | None = None,
    account_env: str | None = None,
    status: str | None = None,
    limit: int = 10000,
):
    store = get_trades_pnl_store()
    trades = store.list_trades(
        broker=broker, account_env=account_env, status=status, limit=limit
    )

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=_CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for trade in trades:
        writer.writerow({col: trade.get(col) for col in _CSV_COLUMNS})
    buffer.seek(0)

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=trades_pnl_report.csv"},
    )


def _normalize_env(account_env: str | None) -> str:
    return "live" if (account_env or "demo").lower() == "live" else "demo"


def _parse_day(day: str | None) -> date:
    if not day:
        return datetime.now(timezone.utc).date()
    try:
        return date.fromisoformat(day)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date — use YYYY-MM-DD") from exc


def _ts_on_day(raw: Any, day: date) -> bool:
    if not raw:
        return False
    text = str(raw).replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).date() == day


def _iso_ts(raw: Any) -> str | None:
    if not raw:
        return None
    text = str(raw).replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return str(raw)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


async def _etoro_client(account_env: str):
    from brokers.etoro.order_client import EtoroV2BracketOrderClient

    env = _normalize_env(account_env)
    client = EtoroV2BracketOrderClient(account_env=env)
    client.generate_session()
    return client


@router.get(
    "/etoro-day",
    operation_id="list_etoro_day_trades",
    summary="List eToro closed trades for a calendar day (for manual Order activity import)",
)
async def list_etoro_day_trades(
    account_env: str = "live",
    day: str | None = None,
    ticker: str | None = None,
):
    from brokers.etoro.adapters.portfolio import etoro_symbol_map_for_records

    env = _normalize_env(account_env)
    target_day = _parse_day(day)
    ticker_q = (ticker or "").strip().upper()

    try:
        client = await _etoro_client(env)
        # Pull a couple of days so timezone edges don't drop local-day closes.
        min_date = (target_day - timedelta(days=1)).isoformat()
        rows: list[dict[str, Any]] = []
        for page in range(1, 6):
            chunk = await client.aget_trade_history(
                min_date=min_date,
                page=page,
                page_size=50,
            )
            if not chunk:
                break
            rows.extend(chunk)
            if len(chunk) < 50:
                break
    except Exception as exc:
        log.warning("[TRADES_PNL] etoro day history failed env=%s: %s", env, exc)
        raise HTTPException(status_code=502, detail=f"eToro trade history failed: {exc}") from exc

    day_rows = [
        row for row in rows
        if _ts_on_day(row.get("closeTimestamp") or row.get("closeDateTime"), target_day)
    ]
    symbol_map = await etoro_symbol_map_for_records(client, day_rows)
    store = get_trades_pnl_store()

    out: list[dict[str, Any]] = []
    for row in day_rows:
        fields = settled_fields_from_closed_trade(row)
        if not fields:
            continue
        instrument_id = row.get("instrumentId") or row.get("instrumentID")
        try:
            iid = int(instrument_id) if instrument_id is not None else None
        except (TypeError, ValueError):
            iid = None
        symbol = ""
        if iid is not None:
            symbol = str(symbol_map.get(iid) or "").strip()
        if not symbol:
            symbol = str(instrument_id or "UNKNOWN")
        root = symbol.split(".")[0].upper()
        if ticker_q and ticker_q not in symbol.upper() and ticker_q != root:
            continue
        position_id = str(row.get("positionId") or row.get("positionID") or "")
        out.append({
            "position_id": position_id,
            "order_id": str(fields.get("order_id") or row.get("orderId") or "") or None,
            "instrument_id": iid,
            "symbol": symbol,
            "ticker": root or symbol,
            "is_buy": bool(row.get("isBuy", True)),
            "units": fields.get("units"),
            "investment": fields.get("investment"),
            "entry_price": fields.get("buy_price"),
            "exit_price": fields.get("sell_price"),
            "pnl": fields.get("pnl"),
            "pnl_pct": fields.get("pnl_pct"),
            "fees": fields.get("fees"),
            "opened_at": _iso_ts(fields.get("open_timestamp")),
            "closed_at": _iso_ts(fields.get("close_timestamp")),
            "already_imported": store.has_position(
                position_id=position_id,
                broker="etoro",
                account_env=env,
            ) if position_id else False,
        })

    out.sort(key=lambda item: str(item.get("closed_at") or ""), reverse=True)
    return {
        "status": True,
        "account_env": env,
        "day": target_day.isoformat(),
        "count": len(out),
        "data": out,
    }


class ImportEtoroTradeRequest(BaseModel):
    account_env: str = "live"
    position_id: str
    source: str = Field(default="positions")
    symbol: str | None = None
    entry_price: float | None = None
    exit_price: float | None = None
    pnl: float | None = None
    pnl_pct: float | None = None
    units: float | None = None
    investment: float | None = None
    order_id: str | None = None
    opened_at: str | None = None
    closed_at: str | None = None
    close_reason: str | None = "manual_import"


@router.post(
    "/import",
    operation_id="import_etoro_trade_pnl",
    summary="Import one eToro closed trade into Order activity",
)
async def import_etoro_trade_pnl(req: ImportEtoroTradeRequest):
    env = _normalize_env(req.account_env)
    source = (req.source or "positions").strip().lower()
    if source not in _IMPORT_SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"source must be one of: {', '.join(_IMPORT_SOURCES)}",
        )
    position_id = (req.position_id or "").strip()
    if not position_id:
        raise HTTPException(status_code=400, detail="position_id required")

    symbol = (req.symbol or "").strip()
    entry = req.entry_price
    exit_ = req.exit_price
    pnl = req.pnl
    pnl_pct = req.pnl_pct
    units = req.units
    investment = req.investment
    order_id = req.order_id
    opened_at = req.opened_at
    closed_at = req.closed_at

    # Prefer fresh broker history when the client only sent a position id.
    if entry is None or exit_ is None or pnl is None or not symbol:
        try:
            client = await _etoro_client(env)
            from brokers.etoro.adapters.portfolio import etoro_symbol_map_for_records

            row = await client.afind_closed_trade(position_id=position_id)
            if not row:
                raise HTTPException(status_code=404, detail="Closed trade not found on eToro")
            fields = settled_fields_from_closed_trade(row)
            if not fields:
                raise HTTPException(status_code=502, detail="Could not parse eToro trade row")
            entry = entry if entry is not None else fields.get("buy_price")
            exit_ = exit_ if exit_ is not None else fields.get("sell_price")
            pnl = pnl if pnl is not None else fields.get("pnl")
            pnl_pct = pnl_pct if pnl_pct is not None else fields.get("pnl_pct")
            units = units if units is not None else fields.get("units")
            investment = investment if investment is not None else fields.get("investment")
            order_id = order_id or (str(fields.get("order_id")) if fields.get("order_id") else None)
            opened_at = opened_at or _iso_ts(fields.get("open_timestamp"))
            closed_at = closed_at or _iso_ts(fields.get("close_timestamp"))
            if not symbol:
                symbol_map = await etoro_symbol_map_for_records(client, [row])
                iid = row.get("instrumentId") or row.get("instrumentID")
                try:
                    symbol = str(symbol_map.get(int(iid)) or iid)
                except (TypeError, ValueError):
                    symbol = str(iid or "UNKNOWN")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"eToro lookup failed: {exc}") from exc

    saved = get_trades_pnl_store().record_completed_ui_trade(
        position_id=position_id,
        source=source,
        broker="etoro",
        account_env=env,
        symbol=symbol,
        entry_price=entry,
        exit_price=exit_,
        pnl=pnl,
        pnl_pct=pnl_pct,
        close_reason=req.close_reason or "manual_import",
        order_id=order_id,
        quantity=units,
        capital=investment,
        opened_at=opened_at,
        closed_at=closed_at,
    )
    if not saved:
        raise HTTPException(status_code=400, detail="Could not save trade — missing required fields")
    return {"status": True, "data": saved}
