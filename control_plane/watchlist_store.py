from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


class WatchlistStore:
    """Persist named watchlists and their symbols."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_database()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_watchlist_columns(conn)
        return conn

    def _init_database(self) -> None:
        conn = self._connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS watchlists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                broker TEXT NOT NULL DEFAULT 'angel',
                account_env TEXT NOT NULL DEFAULT 'live',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS watchlist_symbols (
                id TEXT PRIMARY KEY,
                watchlist_id TEXT NOT NULL,
                symboltoken TEXT NOT NULL,
                tradingsymbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'NSE',
                symbol TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
                UNIQUE(watchlist_id, symboltoken)
            );

            CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_watchlist
                ON watchlist_symbols(watchlist_id);
            """
        )
        conn.commit()
        conn.close()

    def _ensure_watchlist_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(watchlists)")}
        if "broker" not in columns:
            conn.execute(
                "ALTER TABLE watchlists ADD COLUMN broker TEXT NOT NULL DEFAULT 'angel'"
            )
        if "account_env" not in columns:
            conn.execute(
                "ALTER TABLE watchlists ADD COLUMN account_env TEXT NOT NULL DEFAULT 'live'"
            )
        conn.commit()

    @staticmethod
    def _watchlist_payload(row: sqlite3.Row, symbols: list[dict[str, Any]]) -> dict[str, Any]:
        data = dict(row)
        keys = data.keys()
        broker = data["broker"] if "broker" in keys else "angel"
        account_env = data["account_env"] if "account_env" in keys else "live"
        return {
            "id": data["id"],
            "name": data["name"],
            "position": data["position"],
            "broker": broker,
            "account_env": account_env,
            "created_at": data["created_at"],
            "updated_at": data["updated_at"],
            "symbols": symbols,
        }

    def list_watchlists(self) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM watchlists ORDER BY position ASC, created_at ASC"
        ).fetchall()
        symbols = conn.execute(
            "SELECT * FROM watchlist_symbols ORDER BY position ASC, created_at ASC"
        ).fetchall()
        conn.close()

        by_watchlist: dict[str, list[dict[str, Any]]] = {}
        for row in symbols:
            item = dict(row)
            by_watchlist.setdefault(item["watchlist_id"], []).append(self._symbol_payload(item))

        return [
            self._watchlist_payload(row, by_watchlist.get(row["id"], []))
            for row in rows
        ]

    @staticmethod
    def _symbol_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "symboltoken": data["symboltoken"],
            "tradingsymbol": data["tradingsymbol"],
            "exchange": data["exchange"],
            "symbol": data.get("symbol") or data["tradingsymbol"],
        }

    def create_watchlist(
        self,
        name: str,
        *,
        broker: str = "angel",
        account_env: str | None = None,
    ) -> dict[str, Any]:
        watchlist_id = str(uuid.uuid4())
        now = _now_utc()
        broker_name = (broker or "angel").lower()
        env = account_env or ("demo" if broker_name == "etoro" else "live")
        conn = self._connect()
        self._ensure_watchlist_columns(conn)
        position = conn.execute("SELECT COUNT(*) AS c FROM watchlists").fetchone()["c"]
        conn.execute(
            """
            INSERT INTO watchlists (id, name, position, broker, account_env, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (watchlist_id, name.strip() or "Watchlist", position, broker_name, env, now, now),
        )
        conn.commit()
        conn.close()
        return self.get_watchlist(watchlist_id) or {}

    def get_watchlist(self, watchlist_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM watchlists WHERE id = ?", (watchlist_id,)).fetchone()
        if not row:
            conn.close()
            return None
        symbols = conn.execute(
            "SELECT * FROM watchlist_symbols WHERE watchlist_id = ? ORDER BY position ASC, created_at ASC",
            (watchlist_id,),
        ).fetchall()
        conn.close()
        return self._watchlist_payload(row, [self._symbol_payload(item) for item in symbols])

    def update_watchlist(
        self,
        watchlist_id: str,
        *,
        name: str | None = None,
        broker: str | None = None,
        account_env: str | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_watchlist(watchlist_id)
        if not existing:
            return None
        conn = self._connect()
        self._ensure_watchlist_columns(conn)
        next_name = (name or existing["name"]).strip() or existing["name"]
        next_broker = (broker or existing.get("broker") or "angel").lower()
        next_env = account_env or existing.get("account_env") or (
            "demo" if next_broker == "etoro" else "live"
        )
        conn.execute(
            """
            UPDATE watchlists
            SET name = ?, broker = ?, account_env = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_name, next_broker, next_env, _now_utc(), watchlist_id),
        )
        conn.commit()
        conn.close()
        return self.get_watchlist(watchlist_id)

    def rename_watchlist(self, watchlist_id: str, name: str) -> dict[str, Any] | None:
        return self.update_watchlist(watchlist_id, name=name)

    def delete_watchlist(self, watchlist_id: str) -> bool:
        conn = self._connect()
        cur = conn.execute("DELETE FROM watchlists WHERE id = ?", (watchlist_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted

    def add_symbol(
        self,
        watchlist_id: str,
        *,
        symboltoken: str,
        tradingsymbol: str,
        exchange: str = "NSE",
        symbol: str | None = None,
    ) -> dict[str, Any] | None:
        if not self.get_watchlist(watchlist_id):
            return None
        symbol_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        position = conn.execute(
            "SELECT COUNT(*) AS c FROM watchlist_symbols WHERE watchlist_id = ?",
            (watchlist_id,),
        ).fetchone()["c"]
        conn.execute(
            """
            INSERT OR IGNORE INTO watchlist_symbols
                (id, watchlist_id, symboltoken, tradingsymbol, exchange, symbol, position, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                symbol_id,
                watchlist_id,
                str(symboltoken),
                tradingsymbol.strip().upper(),
                (exchange or "NSE").upper(),
                (symbol or tradingsymbol).strip().upper(),
                position,
                now,
            ),
        )
        conn.execute(
            "UPDATE watchlists SET updated_at = ? WHERE id = ?",
            (_now_utc(), watchlist_id),
        )
        conn.commit()
        conn.close()
        return self.get_watchlist(watchlist_id)

    def remove_symbol(self, watchlist_id: str, symboltoken: str) -> dict[str, Any] | None:
        conn = self._connect()
        conn.execute(
            "DELETE FROM watchlist_symbols WHERE watchlist_id = ? AND symboltoken = ?",
            (watchlist_id, str(symboltoken)),
        )
        conn.execute(
            "UPDATE watchlists SET updated_at = ? WHERE id = ?",
            (_now_utc(), watchlist_id),
        )
        conn.commit()
        conn.close()
        return self.get_watchlist(watchlist_id)


_store: WatchlistStore | None = None


def get_watchlist_store() -> WatchlistStore:
    global _store
    if _store is None:
        _store = WatchlistStore()
    return _store
