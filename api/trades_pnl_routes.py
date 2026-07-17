from __future__ import annotations

import csv
import io

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from control_plane.trades_pnl_store import get_trades_pnl_store

router = APIRouter(prefix="/api/trades-pnl", tags=["trades-pnl"])

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
