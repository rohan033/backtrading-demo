from __future__ import annotations

import json
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


class TradedInstrumentsStore:
    """Permanent registry of instruments that have ever appeared as a position.

    Deduped per (broker, account_env, symboltoken). Tracks first/last traded
    timestamps and a running trade count so the UI can surface a "Past traded"
    watchlist that survives across sessions.
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
            CREATE TABLE IF NOT EXISTS traded_instruments (
                id TEXT PRIMARY KEY,
                broker TEXT NOT NULL DEFAULT 'etoro',
                account_env TEXT NOT NULL DEFAULT 'demo',
                symboltoken TEXT NOT NULL,
                tradingsymbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'ETORO',
                symbol TEXT,
                internal_asset_class_name TEXT,
                instrument_display_name TEXT,
                logo35x35 TEXT,
                logo50x50 TEXT,
                logo150x150 TEXT,
                raw_metadata_json TEXT,
                last_position_id TEXT,
                last_side TEXT,
                trade_count INTEGER NOT NULL DEFAULT 1,
                first_traded_at TEXT NOT NULL,
                last_traded_at TEXT NOT NULL,
                metadata_updated_at TEXT,
                UNIQUE(broker, account_env, symboltoken)
            );

            CREATE INDEX IF NOT EXISTS idx_traded_instruments_scope
                ON traded_instruments(broker, account_env, last_traded_at DESC);
            """
        )
        conn.commit()
        conn.close()

    @staticmethod
    def _payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "broker": data["broker"],
            "account_env": data["account_env"],
            "symboltoken": data["symboltoken"],
            "tradingsymbol": data["tradingsymbol"],
            "exchange": data.get("exchange") or "ETORO",
            "symbol": data.get("symbol") or data["tradingsymbol"],
            "internal_asset_class_name": data.get("internal_asset_class_name"),
            "instrument_display_name": data.get("instrument_display_name"),
            "logo35x35": data.get("logo35x35"),
            "logo50x50": data.get("logo50x50"),
            "logo150x150": data.get("logo150x150"),
            "raw_metadata_json": data.get("raw_metadata_json"),
            "last_position_id": data.get("last_position_id"),
            "last_side": data.get("last_side"),
            "trade_count": data.get("trade_count") or 0,
            "first_traded_at": data.get("first_traded_at"),
            "last_traded_at": data.get("last_traded_at"),
            "metadata_updated_at": data.get("metadata_updated_at"),
        }

    def list_instruments(
        self,
        *,
        broker: str | None = None,
        account_env: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if broker:
            clauses.append("broker = ?")
            params.append(broker.lower())
        if account_env:
            clauses.append("account_env = ?")
            params.append(account_env.lower())
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        conn = self._connect()
        rows = conn.execute(
            f"SELECT * FROM traded_instruments {where} "
            "ORDER BY last_traded_at DESC, tradingsymbol ASC",
            params,
        ).fetchall()
        conn.close()
        return [self._payload(row) for row in rows]

    def upsert(
        self,
        *,
        symboltoken: str,
        tradingsymbol: str,
        broker: str = "etoro",
        account_env: str = "demo",
        exchange: str = "ETORO",
        symbol: str | None = None,
        internal_asset_class_name: str | None = None,
        instrument_display_name: str | None = None,
        logo35x35: str | None = None,
        logo50x50: str | None = None,
        logo150x150: str | None = None,
        raw_metadata: dict[str, Any] | None = None,
        position_id: str | None = None,
        side: str | None = None,
        bump_trade_count: bool = True,
    ) -> dict[str, Any] | None:
        token = _clean(symboltoken)
        ticker = _clean(tradingsymbol) or token
        if not token or not ticker:
            return None

        broker_name = (broker or "etoro").lower()
        env = (account_env or "demo").lower()
        now = _now_utc()
        has_metadata = any(
            (
                internal_asset_class_name,
                instrument_display_name,
                logo35x35,
                logo50x50,
                logo150x150,
                raw_metadata,
            )
        )
        raw_metadata_json = (
            json.dumps(raw_metadata, separators=(",", ":")) if raw_metadata else None
        )
        metadata_updated_at = now if has_metadata else None

        conn = self._connect()
        existing = conn.execute(
            "SELECT * FROM traded_instruments WHERE broker = ? AND account_env = ? AND symboltoken = ?",
            (broker_name, env, token),
        ).fetchone()

        if existing is None:
            conn.execute(
                """
                INSERT INTO traded_instruments (
                    id, broker, account_env, symboltoken, tradingsymbol, exchange, symbol,
                    internal_asset_class_name, instrument_display_name,
                    logo35x35, logo50x50, logo150x150, raw_metadata_json,
                    last_position_id, last_side, trade_count,
                    first_traded_at, last_traded_at, metadata_updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    broker_name,
                    env,
                    token,
                    ticker.upper(),
                    (exchange or "ETORO").upper(),
                    _clean(symbol) or ticker.upper(),
                    _clean(internal_asset_class_name),
                    _clean(instrument_display_name),
                    _clean(logo35x35),
                    _clean(logo50x50),
                    _clean(logo150x150),
                    raw_metadata_json,
                    _clean(position_id),
                    _clean(side),
                    1,
                    now,
                    now,
                    metadata_updated_at,
                ),
            )
        else:
            next_count = (existing["trade_count"] or 0) + (1 if bump_trade_count else 0)
            conn.execute(
                """
                UPDATE traded_instruments
                SET
                    tradingsymbol = COALESCE(?, tradingsymbol),
                    symbol = COALESCE(?, symbol),
                    internal_asset_class_name = COALESCE(?, internal_asset_class_name),
                    instrument_display_name = COALESCE(?, instrument_display_name),
                    logo35x35 = COALESCE(?, logo35x35),
                    logo50x50 = COALESCE(?, logo50x50),
                    logo150x150 = COALESCE(?, logo150x150),
                    raw_metadata_json = COALESCE(?, raw_metadata_json),
                    last_position_id = COALESCE(?, last_position_id),
                    last_side = COALESCE(?, last_side),
                    trade_count = ?,
                    last_traded_at = ?,
                    metadata_updated_at = COALESCE(?, metadata_updated_at)
                WHERE broker = ? AND account_env = ? AND symboltoken = ?
                """,
                (
                    ticker.upper(),
                    _clean(symbol),
                    _clean(internal_asset_class_name),
                    _clean(instrument_display_name),
                    _clean(logo35x35),
                    _clean(logo50x50),
                    _clean(logo150x150),
                    raw_metadata_json,
                    _clean(position_id),
                    _clean(side),
                    next_count,
                    now,
                    metadata_updated_at,
                    broker_name,
                    env,
                    token,
                ),
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM traded_instruments WHERE broker = ? AND account_env = ? AND symboltoken = ?",
            (broker_name, env, token),
        ).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def upsert_from_position_row(
        self,
        row: dict[str, Any],
        *,
        broker: str = "etoro",
        account_env: str = "demo",
        bump_trade_count: bool = False,
    ) -> dict[str, Any] | None:
        """Capture a normalized portfolio/position row (see etoro adapters)."""
        token = _clean(row.get("symboltoken") or row.get("instrument_id") or row.get("instrumentID"))
        if not token:
            return None
        return self.upsert(
            symboltoken=token,
            tradingsymbol=_clean(row.get("tradingsymbol")) or token,
            broker=broker,
            account_env=account_env,
            exchange=_clean(row.get("exchange")) or "ETORO",
            symbol=_clean(row.get("symbol") or row.get("instrument_display_name")),
            internal_asset_class_name=_clean(row.get("internal_asset_class_name")),
            instrument_display_name=_clean(row.get("instrument_display_name") or row.get("symbol")),
            logo35x35=_clean(row.get("logo35x35")),
            logo50x50=_clean(row.get("logo50x50")),
            logo150x150=_clean(row.get("logo150x150")),
            position_id=_clean(row.get("position_id")),
            bump_trade_count=bump_trade_count,
        )

    def remove(self, *, broker: str, account_env: str, symboltoken: str) -> bool:
        conn = self._connect()
        cur = conn.execute(
            "DELETE FROM traded_instruments WHERE broker = ? AND account_env = ? AND symboltoken = ?",
            ((broker or "etoro").lower(), (account_env or "demo").lower(), str(symboltoken)),
        )
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted


_store: TradedInstrumentsStore | None = None


def get_traded_instruments_store() -> TradedInstrumentsStore:
    global _store
    if _store is None:
        _store = TradedInstrumentsStore()
    return _store
