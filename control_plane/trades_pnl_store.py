from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class TradesPnlStore:
    """Durable ledger of momentum trades for later reporting.

    One row per trade (keyed by execution_id). Entry details are written when
    the momentum order is placed; exit details + realized P&L are filled in when
    the position is closed. Rows survive across restarts so reports can be
    generated at any time.
    """

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_database()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_database(self) -> None:
        conn = self._connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS trades_pnl (
                id TEXT PRIMARY KEY,
                execution_id TEXT,
                order_id TEXT,
                position_id TEXT,
                source TEXT NOT NULL DEFAULT 'momentum',
                broker TEXT NOT NULL DEFAULT 'etoro',
                account_env TEXT NOT NULL DEFAULT 'demo',
                symbol TEXT,
                tradingsymbol TEXT,
                symboltoken TEXT,
                exchange TEXT NOT NULL DEFAULT 'ETORO',
                side TEXT NOT NULL DEFAULT 'buy',
                quantity REAL,
                capital REAL,
                entry_price REAL,
                exit_price REAL,
                take_profit_price REAL,
                stop_loss_price REAL,
                pnl REAL,
                pnl_pct REAL,
                status TEXT NOT NULL DEFAULT 'open',
                close_reason TEXT,
                opened_at TEXT NOT NULL,
                closed_at TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_trades_pnl_scope
                ON trades_pnl(broker, account_env, opened_at DESC);
            CREATE INDEX IF NOT EXISTS idx_trades_pnl_execution
                ON trades_pnl(execution_id);
            CREATE INDEX IF NOT EXISTS idx_trades_pnl_status
                ON trades_pnl(status);
            """
        )
        conn.commit()
        conn.close()

    @staticmethod
    def _payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "execution_id": data.get("execution_id"),
            "order_id": data.get("order_id"),
            "position_id": data.get("position_id"),
            "source": data.get("source") or "momentum",
            "broker": data.get("broker") or "etoro",
            "account_env": data.get("account_env") or "demo",
            "symbol": data.get("symbol"),
            "tradingsymbol": data.get("tradingsymbol"),
            "symboltoken": data.get("symboltoken"),
            "exchange": data.get("exchange") or "ETORO",
            "side": data.get("side") or "buy",
            "quantity": data.get("quantity"),
            "capital": data.get("capital"),
            "entry_price": data.get("entry_price"),
            "exit_price": data.get("exit_price"),
            "take_profit_price": data.get("take_profit_price"),
            "stop_loss_price": data.get("stop_loss_price"),
            "pnl": data.get("pnl"),
            "pnl_pct": data.get("pnl_pct"),
            "status": data.get("status") or "open",
            "close_reason": data.get("close_reason"),
            "opened_at": data.get("opened_at"),
            "closed_at": data.get("closed_at"),
            "updated_at": data.get("updated_at"),
        }

    def record_entry(
        self,
        *,
        execution_id: str | None,
        order_id: str | None = None,
        source: str = "momentum",
        broker: str = "etoro",
        account_env: str = "demo",
        symbol: str | None = None,
        tradingsymbol: str | None = None,
        symboltoken: str | None = None,
        exchange: str = "ETORO",
        side: str = "buy",
        quantity: float | None = None,
        capital: float | None = None,
        entry_price: float | None = None,
        take_profit_price: float | None = None,
        stop_loss_price: float | None = None,
    ) -> dict[str, Any] | None:
        """Insert a new open trade. Idempotent per execution_id (updates if seen)."""
        now = _now_utc()
        broker_name = (broker or "etoro").lower()
        env = (account_env or "demo").lower()
        exec_id = _clean(execution_id)

        conn = self._connect()
        existing = None
        if exec_id:
            existing = conn.execute(
                "SELECT * FROM trades_pnl WHERE execution_id = ?",
                (exec_id,),
            ).fetchone()

        if existing is None:
            row_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO trades_pnl (
                    id, execution_id, order_id, position_id, source, broker, account_env,
                    symbol, tradingsymbol, symboltoken, exchange, side,
                    quantity, capital, entry_price, take_profit_price, stop_loss_price,
                    status, opened_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
                """,
                (
                    row_id,
                    exec_id,
                    _clean(order_id),
                    None,
                    (source or "momentum").lower(),
                    broker_name,
                    env,
                    _clean(symbol) or _clean(tradingsymbol),
                    _clean(tradingsymbol),
                    _clean(symboltoken),
                    (exchange or "ETORO").upper(),
                    (side or "buy").lower(),
                    _num(quantity),
                    _num(capital),
                    _num(entry_price),
                    _num(take_profit_price),
                    _num(stop_loss_price),
                    now,
                    now,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE trades_pnl
                SET
                    order_id = COALESCE(?, order_id),
                    symbol = COALESCE(?, symbol),
                    tradingsymbol = COALESCE(?, tradingsymbol),
                    symboltoken = COALESCE(?, symboltoken),
                    quantity = COALESCE(?, quantity),
                    capital = COALESCE(?, capital),
                    entry_price = COALESCE(?, entry_price),
                    take_profit_price = COALESCE(?, take_profit_price),
                    stop_loss_price = COALESCE(?, stop_loss_price),
                    updated_at = ?
                WHERE execution_id = ?
                """,
                (
                    _clean(order_id),
                    _clean(symbol) or _clean(tradingsymbol),
                    _clean(tradingsymbol),
                    _clean(symboltoken),
                    _num(quantity),
                    _num(capital),
                    _num(entry_price),
                    _num(take_profit_price),
                    _num(stop_loss_price),
                    now,
                    exec_id,
                ),
            )
        conn.commit()
        row = None
        if exec_id:
            row = conn.execute(
                "SELECT * FROM trades_pnl WHERE execution_id = ?", (exec_id,)
            ).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def record_exit(
        self,
        *,
        execution_id: str | None,
        position_id: str | None = None,
        exit_price: float | None = None,
        entry_price: float | None = None,
        pnl: float | None = None,
        pnl_pct: float | None = None,
        close_reason: str | None = None,
    ) -> dict[str, Any] | None:
        """Mark the trade for an execution as closed and record realized P&L."""
        exec_id = _clean(execution_id)
        if not exec_id:
            return None
        now = _now_utc()
        conn = self._connect()
        existing = conn.execute(
            "SELECT * FROM trades_pnl WHERE execution_id = ?", (exec_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return None
        conn.execute(
            """
            UPDATE trades_pnl
            SET
                position_id = COALESCE(?, position_id),
                exit_price = COALESCE(?, exit_price),
                entry_price = COALESCE(?, entry_price),
                pnl = COALESCE(?, pnl),
                pnl_pct = COALESCE(?, pnl_pct),
                close_reason = COALESCE(?, close_reason),
                status = 'closed',
                closed_at = ?,
                updated_at = ?
            WHERE execution_id = ?
            """,
            (
                _clean(position_id),
                _num(exit_price),
                _num(entry_price),
                _num(pnl),
                _num(pnl_pct),
                _clean(close_reason),
                now,
                now,
                exec_id,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM trades_pnl WHERE execution_id = ?", (exec_id,)
        ).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def record_completed_ui_trade(
        self,
        *,
        position_id: str | None,
        source: str,
        broker: str = "etoro",
        account_env: str = "demo",
        symbol: str | None = None,
        entry_price: float | None = None,
        exit_price: float | None = None,
        pnl: float | None = None,
        pnl_pct: float | None = None,
        close_reason: str | None = None,
    ) -> dict[str, Any] | None:
        """Persist a finalized trade closed by the Positions UI or its automation."""
        position = _clean(position_id)
        ticker = _clean(symbol)
        buy = _num(entry_price)
        sell = _num(exit_price)
        profit = _num(pnl)
        profit_pct = _num(pnl_pct)
        if not position or not ticker or buy is None or sell is None:
            return None
        if profit is None and profit_pct is None:
            return None

        now = _now_utc()
        broker_name = (broker or "etoro").lower()
        env = (account_env or "demo").lower()
        trade_source = (source or "positions").lower()
        conn = self._connect()
        existing = conn.execute(
            """
            SELECT * FROM trades_pnl
            WHERE broker = ? AND account_env = ? AND position_id = ?
            ORDER BY opened_at DESC
            LIMIT 1
            """,
            (broker_name, env, position),
        ).fetchone()

        if existing is None:
            row_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO trades_pnl (
                    id, position_id, source, broker, account_env, symbol,
                    tradingsymbol, exchange, side, entry_price, exit_price,
                    pnl, pnl_pct, status, close_reason, opened_at, closed_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'ETORO', 'buy', ?, ?, ?, ?,
                        'closed', ?, ?, ?, ?)
                """,
                (
                    row_id,
                    position,
                    trade_source,
                    broker_name,
                    env,
                    ticker,
                    ticker,
                    buy,
                    sell,
                    profit,
                    profit_pct,
                    _clean(close_reason),
                    now,
                    now,
                    now,
                ),
            )
        else:
            row_id = existing["id"]
            conn.execute(
                """
                UPDATE trades_pnl
                SET source = ?, symbol = ?, tradingsymbol = ?,
                    entry_price = ?, exit_price = ?, pnl = ?, pnl_pct = ?,
                    status = 'closed', close_reason = ?, closed_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    trade_source,
                    ticker,
                    ticker,
                    buy,
                    sell,
                    profit,
                    profit_pct,
                    _clean(close_reason),
                    now,
                    now,
                    row_id,
                ),
            )

        conn.commit()
        row = conn.execute("SELECT * FROM trades_pnl WHERE id = ?", (row_id,)).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def list_trades(
        self,
        *,
        broker: str | None = None,
        account_env: str | None = None,
        status: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if broker:
            clauses.append("broker = ?")
            params.append(broker.lower())
        if account_env:
            clauses.append("account_env = ?")
            params.append(account_env.lower())
        if status:
            clauses.append("status = ?")
            params.append(status.lower())
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(int(limit))
        conn = self._connect()
        rows = conn.execute(
            f"SELECT * FROM trades_pnl {where} ORDER BY opened_at DESC LIMIT ?",
            params,
        ).fetchall()
        conn.close()
        return [self._payload(row) for row in rows]

    def summary(
        self,
        *,
        broker: str | None = None,
        account_env: str | None = None,
    ) -> dict[str, Any]:
        trades = self.list_trades(broker=broker, account_env=account_env)
        closed = [t for t in trades if t["status"] == "closed"]
        realized = sum((t["pnl"] or 0) for t in closed)
        wins = [t for t in closed if (t["pnl"] or 0) > 0]
        losses = [t for t in closed if (t["pnl"] or 0) < 0]
        return {
            "total_trades": len(trades),
            "open_trades": len(trades) - len(closed),
            "closed_trades": len(closed),
            "realized_pnl": round(realized, 2),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(len(wins) / len(closed), 4) if closed else None,
        }


_store: TradesPnlStore | None = None


def get_trades_pnl_store() -> TradesPnlStore:
    global _store
    if _store is None:
        _store = TradesPnlStore()
    return _store
