from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from typing import Any

from control_plane.watchlist_store import DB_PATH


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def transaction_key(symbol: str, row: dict[str, Any]) -> str:
    parts = [
        symbol.strip().upper(),
        str(row.get("name") or "").strip(),
        str(row.get("transactionDate") or "").strip(),
        str(row.get("filingDate") or "").strip(),
        str(row.get("change") or ""),
        str(row.get("transactionCode") or "").strip(),
        str(row.get("transactionPrice") or ""),
    ]
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return digest


class InsiderStore:
    """Persist Finnhub insider transactions polled from watchlist tickers."""

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
            CREATE TABLE IF NOT EXISTS insider_transactions (
                id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                name TEXT,
                change_shares REAL,
                share REAL,
                filing_date TEXT,
                transaction_date TEXT,
                transaction_code TEXT,
                transaction_price REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_insider_symbol_txn_date
                ON insider_transactions(symbol, transaction_date DESC);

            CREATE INDEX IF NOT EXISTS idx_insider_filing_date
                ON insider_transactions(filing_date DESC);

            CREATE TABLE IF NOT EXISTS insider_poll_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        conn.commit()
        conn.close()

    @staticmethod
    def _coerce_float(value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        if parsed != parsed:  # NaN
            return None
        return parsed

    @staticmethod
    def _payload(row: sqlite3.Row) -> dict[str, Any]:
        try:
            parsed = json.loads(row["payload_json"] or "{}")
        except json.JSONDecodeError:
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}

        change = InsiderStore._coerce_float(parsed.get("change"))
        if change is None:
            change = InsiderStore._coerce_float(row["change_shares"])

        return {
            **parsed,
            "id": row["id"],
            "symbol": row["symbol"],
            "name": row["name"],
            "change": change,
            "share": InsiderStore._coerce_float(parsed.get("share", row["share"])),
            "filingDate": parsed.get("filingDate") or row["filing_date"],
            "transactionDate": parsed.get("transactionDate") or row["transaction_date"],
            "transactionCode": parsed.get("transactionCode") or row["transaction_code"],
            "transactionPrice": InsiderStore._coerce_float(
                parsed.get("transactionPrice", row["transaction_price"])
            ),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def upsert_transactions(
        self,
        symbol: str,
        rows: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        ticker = symbol.strip().upper()
        if not ticker or not rows:
            return []

        now = _now_utc()
        conn = self._connect()
        inserted: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            txn_id = transaction_key(ticker, row)
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO insider_transactions (
                    id, symbol, name, change_shares, share, filing_date,
                    transaction_date, transaction_code, transaction_price,
                    created_at, updated_at, payload_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    txn_id,
                    ticker,
                    row.get("name"),
                    row.get("change"),
                    row.get("share"),
                    row.get("filingDate"),
                    row.get("transactionDate"),
                    row.get("transactionCode"),
                    row.get("transactionPrice"),
                    now,
                    now,
                    json.dumps(row, separators=(",", ":"), ensure_ascii=False),
                ),
            )
            if cur.rowcount > 0:
                inserted.append(self._payload(conn.execute(
                    "SELECT * FROM insider_transactions WHERE id = ?",
                    (txn_id,),
                ).fetchone()))
        conn.commit()
        conn.close()
        return inserted

    def list_transactions(
        self,
        *,
        symbol: str | None = None,
        days: int = 90,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        bounded_days = max(1, min(int(days or 90), 365))
        bounded_limit = max(1, min(int(limit or 500), 1000))
        cutoff = (date.today() - timedelta(days=bounded_days)).isoformat()
        conn = self._connect()
        if symbol:
            rows = conn.execute(
                """
                SELECT * FROM insider_transactions
                WHERE symbol = ?
                  AND COALESCE(transaction_date, filing_date, '') >= ?
                ORDER BY COALESCE(transaction_date, filing_date) DESC, created_at DESC
                LIMIT ?
                """,
                (symbol.strip().upper(), cutoff, bounded_limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM insider_transactions
                WHERE COALESCE(transaction_date, filing_date, '') >= ?
                ORDER BY COALESCE(transaction_date, filing_date) DESC, created_at DESC
                LIMIT ?
                """,
                (cutoff, bounded_limit),
            ).fetchall()
        conn.close()
        return [self._payload(row) for row in rows]

    def set_poll_timestamp(self) -> None:
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO insider_poll_state (key, value)
            VALUES ('last_polled_at', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (_now_utc(),),
        )
        conn.commit()
        conn.close()

    def last_polled_at(self) -> str | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT value FROM insider_poll_state WHERE key = 'last_polled_at'"
        ).fetchone()
        conn.close()
        return str(row["value"]) if row else None


_store: InsiderStore | None = None


def get_insider_store() -> InsiderStore:
    global _store
    if _store is None:
        _store = InsiderStore()
    return _store
