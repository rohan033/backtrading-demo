"""Persistent eToro symbol → instrument_id cache in control_plane.db."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")

log = logging.getLogger(__name__)


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_env(account_env: str | None) -> str:
    return "demo" if (account_env or "demo").lower() == "demo" else "live"


def _ticker_root(value: str) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    return text.split(".", 1)[0].split("-", 1)[0]


def _ticker_score(tradingsymbol: str, symbol_field: str, ticker: str) -> int:
    target = str(ticker or "").strip().upper()
    if not target:
        return 0
    target_root = _ticker_root(target)
    ts = str(tradingsymbol or "").strip().upper()
    sym = str(symbol_field or "").strip().upper()
    if not ts and not sym:
        return 0
    if ts == target and ("." in ts or "-" in ts):
        return 100
    if target_root and ts in {f"{target_root}.US", f"{target_root}.RTH"}:
        return 90
    if ts == target or sym == target:
        return 80
    if target_root and ts.startswith(f"{target_root}."):
        return 70
    if target_root and _ticker_root(ts) == target_root:
        return 60
    if target_root and _ticker_root(sym) == target_root:
        return 50
    return 0


class EtoroDb:
    """Local cache of eToro ticker ↔ instrument_id mappings."""

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
            CREATE TABLE IF NOT EXISTS etoro_instruments (
                id TEXT PRIMARY KEY,
                account_env TEXT NOT NULL DEFAULT 'live',
                ticker_root TEXT NOT NULL,
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
                source TEXT NOT NULL DEFAULT 'watchlist',
                updated_at TEXT NOT NULL,
                UNIQUE(account_env, symboltoken)
            );

            CREATE INDEX IF NOT EXISTS idx_etoro_instruments_ticker
                ON etoro_instruments(account_env, ticker_root);
            CREATE INDEX IF NOT EXISTS idx_etoro_instruments_token
                ON etoro_instruments(account_env, symboltoken);
            CREATE INDEX IF NOT EXISTS idx_etoro_instruments_tradingsymbol
                ON etoro_instruments(account_env, tradingsymbol);
            """
        )
        conn.commit()
        conn.close()

    @staticmethod
    def _payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "account_env": data["account_env"],
            "ticker_root": data["ticker_root"],
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
            "source": data.get("source") or "watchlist",
            "updated_at": data.get("updated_at"),
        }

    @classmethod
    def to_search_row(cls, record: dict[str, Any]) -> dict[str, Any]:
        tradingsymbol = str(record.get("tradingsymbol") or "").strip()
        token = str(record.get("symboltoken") or "").strip()
        display = record.get("instrument_display_name") or record.get("symbol") or tradingsymbol
        return {
            "tradingsymbol": tradingsymbol,
            "symboltoken": token,
            "exchange": str(record.get("exchange") or "ETORO"),
            "name": display,
            "symbol": record.get("symbol") or tradingsymbol,
            "instrumentDisplayName": display,
            "instrument_display_name": record.get("instrument_display_name") or display,
            "internalAssetClassName": record.get("internal_asset_class_name"),
            "internal_asset_class_name": record.get("internal_asset_class_name"),
            "logo35x35": record.get("logo35x35"),
            "logo50x50": record.get("logo50x50"),
            "logo150x150": record.get("logo150x150"),
            "from_etoro_db": True,
        }

    def find_by_instrument_id(
        self,
        account_env: str,
        instrument_id: int | str,
    ) -> dict[str, Any] | None:
        env = _normalize_env(account_env)
        token = str(instrument_id or "").strip()
        if not token:
            return None
        hit = self._find_row_by_token(env, token)
        if hit:
            return hit
        alt = "live" if env == "demo" else "demo"
        return self._find_row_by_token(alt, token)

    def _find_row_by_token(self, env: str, token: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM etoro_instruments WHERE account_env = ? AND symboltoken = ?",
            (env, token),
        ).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def find_by_ticker(self, account_env: str, ticker: str) -> dict[str, Any] | None:
        env = _normalize_env(account_env)
        query = str(ticker or "").strip()
        if not query:
            return None
        if query.isdigit():
            hit = self.find_by_instrument_id(env, query)
            if hit:
                return hit

        hit = self._find_best_ticker_match(env, query)
        if hit:
            return hit
        alt = "live" if env == "demo" else "demo"
        return self._find_best_ticker_match(alt, query)

    def _find_best_ticker_match(self, env: str, query: str) -> dict[str, Any] | None:
        target = query.upper()
        root = _ticker_root(target)
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM etoro_instruments
            WHERE account_env = ?
              AND (
                ticker_root = ?
                OR tradingsymbol = ?
                OR symbol = ?
                OR tradingsymbol LIKE ?
              )
            """,
            (env, root or target, target, target, f"{root}.%" if root else target),
        ).fetchall()
        conn.close()
        if not rows:
            return None

        best: dict[str, Any] | None = None
        best_score = 0
        for row in rows:
            payload = self._payload(row)
            score = _ticker_score(
                str(payload.get("tradingsymbol") or ""),
                str(payload.get("symbol") or ""),
                query,
            )
            if score > best_score:
                best_score = score
                best = payload
        return best

    def upsert_from_search_row(
        self,
        row: dict[str, Any],
        *,
        account_env: str,
        source: str = "api",
    ) -> bool:
        token = str(row.get("symboltoken") or row.get("token") or "").strip()
        tradingsymbol = str(row.get("tradingsymbol") or row.get("symbol") or "").strip().upper()
        if not token or not tradingsymbol:
            return False
        return self._upsert(
            account_env=account_env,
            symboltoken=token,
            tradingsymbol=tradingsymbol,
            exchange=str(row.get("exchange") or "ETORO"),
            symbol=str(row.get("symbol") or tradingsymbol).strip().upper(),
            internal_asset_class_name=row.get("internal_asset_class_name")
            or row.get("internalAssetClassName"),
            instrument_display_name=row.get("instrument_display_name")
            or row.get("instrumentDisplayName")
            or row.get("name"),
            logo35x35=row.get("logo35x35"),
            logo50x50=row.get("logo50x50"),
            logo150x150=row.get("logo150x150"),
            raw_metadata=row if isinstance(row, dict) else None,
            source=source,
        )

    def upsert_from_watchlist_symbol(
        self,
        symbol: dict[str, Any],
        *,
        account_env: str,
        source: str = "watchlist",
    ) -> bool:
        token = str(symbol.get("symboltoken") or "").strip()
        tradingsymbol = str(symbol.get("tradingsymbol") or "").strip().upper()
        if not token or not tradingsymbol:
            return False
        raw_metadata = None
        raw_json = symbol.get("raw_metadata_json")
        if raw_json:
            try:
                raw_metadata = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
            except (TypeError, json.JSONDecodeError):
                raw_metadata = None
        return self._upsert(
            account_env=account_env,
            symboltoken=token,
            tradingsymbol=tradingsymbol,
            exchange=str(symbol.get("exchange") or "ETORO"),
            symbol=str(symbol.get("symbol") or tradingsymbol).strip().upper(),
            internal_asset_class_name=symbol.get("internal_asset_class_name"),
            instrument_display_name=symbol.get("instrument_display_name"),
            logo35x35=symbol.get("logo35x35"),
            logo50x50=symbol.get("logo50x50"),
            logo150x150=symbol.get("logo150x150"),
            raw_metadata=raw_metadata,
            source=source,
        )

    def _upsert(
        self,
        *,
        account_env: str,
        symboltoken: str,
        tradingsymbol: str,
        exchange: str,
        symbol: str,
        internal_asset_class_name: str | None,
        instrument_display_name: str | None,
        logo35x35: str | None,
        logo50x50: str | None,
        logo150x150: str | None,
        raw_metadata: dict[str, Any] | None,
        source: str,
    ) -> bool:
        env = _normalize_env(account_env)
        now = _now_utc()
        root = _ticker_root(tradingsymbol) or _ticker_root(symbol)
        raw_metadata_json = (
            json.dumps(raw_metadata, separators=(",", ":")) if raw_metadata else None
        )
        conn = self._connect()
        existing = conn.execute(
            "SELECT id FROM etoro_instruments WHERE account_env = ? AND symboltoken = ?",
            (env, symboltoken),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE etoro_instruments
                SET
                    ticker_root = ?,
                    tradingsymbol = ?,
                    exchange = ?,
                    symbol = ?,
                    internal_asset_class_name = COALESCE(?, internal_asset_class_name),
                    instrument_display_name = COALESCE(?, instrument_display_name),
                    logo35x35 = COALESCE(?, logo35x35),
                    logo50x50 = COALESCE(?, logo50x50),
                    logo150x150 = COALESCE(?, logo150x150),
                    raw_metadata_json = COALESCE(?, raw_metadata_json),
                    source = ?,
                    updated_at = ?
                WHERE account_env = ? AND symboltoken = ?
                """,
                (
                    root,
                    tradingsymbol,
                    exchange,
                    symbol,
                    internal_asset_class_name,
                    instrument_display_name,
                    logo35x35,
                    logo50x50,
                    logo150x150,
                    raw_metadata_json,
                    source,
                    now,
                    env,
                    symboltoken,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO etoro_instruments (
                    id, account_env, ticker_root, symboltoken, tradingsymbol, exchange, symbol,
                    internal_asset_class_name, instrument_display_name,
                    logo35x35, logo50x50, logo150x150, raw_metadata_json,
                    source, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    env,
                    root,
                    symboltoken,
                    tradingsymbol,
                    exchange,
                    symbol,
                    internal_asset_class_name,
                    instrument_display_name,
                    logo35x35,
                    logo50x50,
                    logo150x150,
                    raw_metadata_json,
                    source,
                    now,
                ),
            )
        conn.commit()
        conn.close()
        return True

    def seed_from_watchlists(self) -> int:
        from control_plane.watchlist_store import get_watchlist_store

        count = 0
        for watchlist in get_watchlist_store().list_watchlists():
            if str(watchlist.get("broker") or "").lower() != "etoro":
                continue
            env = watchlist.get("account_env") or "demo"
            for symbol in watchlist.get("symbols") or []:
                if not isinstance(symbol, dict):
                    continue
                if self.upsert_from_watchlist_symbol(symbol, account_env=env, source="watchlist"):
                    count += 1
        if count:
            log.info("[ETORO_DB] seeded %d instruments from watchlists", count)
        return count

    def count(self, account_env: str | None = None) -> int:
        env = _normalize_env(account_env) if account_env else None
        conn = self._connect()
        if env:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM etoro_instruments WHERE account_env = ?",
                (env,),
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) AS c FROM etoro_instruments").fetchone()
        conn.close()
        return int(row["c"]) if row else 0


_store: EtoroDb | None = None


def get_etoro_db() -> EtoroDb:
    global _store
    if _store is None:
        _store = EtoroDb()
    return _store
