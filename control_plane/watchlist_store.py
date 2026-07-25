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


class WatchlistStore:
    """Persist named watchlists and their symbols."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_database()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watchlists'"
        ).fetchone():
            self._ensure_watchlist_columns(conn)
            self._ensure_symbol_metadata_columns(conn)
            self._ensure_panel_schema(conn)
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
                internal_asset_class_name TEXT,
                instrument_display_name TEXT,
                logo35x35 TEXT,
                logo50x50 TEXT,
                logo150x150 TEXT,
                raw_metadata_json TEXT,
                metadata_updated_at TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
                UNIQUE(watchlist_id, symboltoken)
            );

            CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_watchlist
                ON watchlist_symbols(watchlist_id);

            CREATE TABLE IF NOT EXISTS watchlist_panels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self._ensure_watchlist_columns(conn)
        self._ensure_symbol_metadata_columns(conn)
        self._ensure_panel_schema(conn)
        conn.commit()
        conn.close()

    def _ensure_panel_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS watchlist_panels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(watchlists)")}
        if "panel_id" not in columns:
            conn.execute("ALTER TABLE watchlists ADD COLUMN panel_id TEXT")

        panel_count = conn.execute("SELECT COUNT(*) AS c FROM watchlist_panels").fetchone()["c"]
        if panel_count == 0:
            default_id = str(uuid.uuid4())
            now = _now_utc()
            conn.execute(
                """
                INSERT INTO watchlist_panels (id, name, position, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (default_id, "Default", 0, now, now),
            )
            conn.execute(
                "UPDATE watchlists SET panel_id = ? WHERE panel_id IS NULL OR panel_id = ''",
                (default_id,),
            )
        else:
            default_id = conn.execute(
                "SELECT id FROM watchlist_panels ORDER BY position ASC, created_at ASC LIMIT 1"
            ).fetchone()["id"]
            conn.execute(
                "UPDATE watchlists SET panel_id = ? WHERE panel_id IS NULL OR panel_id = ''",
                (default_id,),
            )
        conn.commit()

    def _ensure_watchlist_columns(self, conn: sqlite3.Connection) -> None:
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watchlists'"
        ).fetchone()
        if not table:
            return
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

    def _ensure_symbol_metadata_columns(self, conn: sqlite3.Connection) -> None:
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watchlist_symbols'"
        ).fetchone()
        if not table:
            return
        columns = {row[1] for row in conn.execute("PRAGMA table_info(watchlist_symbols)")}
        additions = {
            "internal_asset_class_name": "TEXT",
            "instrument_display_name": "TEXT",
            "logo35x35": "TEXT",
            "logo50x50": "TEXT",
            "logo150x150": "TEXT",
            "raw_metadata_json": "TEXT",
            "metadata_updated_at": "TEXT",
        }
        for name, type_name in additions.items():
            if name not in columns:
                try:
                    conn.execute(f"ALTER TABLE watchlist_symbols ADD COLUMN {name} {type_name}")
                except sqlite3.OperationalError as exc:
                    # Startup can race under concurrent FastAPI requests. If another
                    # connection added the column after our PRAGMA snapshot, this
                    # migration is already satisfied.
                    if "duplicate column name" not in str(exc).lower():
                        raise
        conn.commit()

    @staticmethod
    def _watchlist_payload(row: sqlite3.Row, symbols: list[dict[str, Any]]) -> dict[str, Any]:
        data = dict(row)
        keys = data.keys()
        broker = data["broker"] if "broker" in keys else "angel"
        account_env = data["account_env"] if "account_env" in keys else "live"
        panel_id = data["panel_id"] if "panel_id" in keys else None
        return {
            "id": data["id"],
            "name": data["name"],
            "position": data["position"],
            "broker": broker,
            "account_env": account_env,
            "panel_id": panel_id,
            "created_at": data["created_at"],
            "updated_at": data["updated_at"],
            "symbols": symbols,
        }

    @staticmethod
    def _panel_payload(row: sqlite3.Row, watchlist_count: int = 0) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "name": data["name"],
            "position": data["position"],
            "created_at": data["created_at"],
            "updated_at": data["updated_at"],
            "watchlist_count": watchlist_count,
        }

    def list_panels(self) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM watchlist_panels ORDER BY position ASC, created_at ASC"
        ).fetchall()
        counts = {
            row["panel_id"]: row["c"]
            for row in conn.execute(
                "SELECT panel_id, COUNT(*) AS c FROM watchlists GROUP BY panel_id"
            ).fetchall()
            if row["panel_id"]
        }
        conn.close()
        return [
            self._panel_payload(row, counts.get(row["id"], 0))
            for row in rows
        ]

    def create_panel(self, name: str) -> dict[str, Any]:
        panel_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        position = conn.execute("SELECT COUNT(*) AS c FROM watchlist_panels").fetchone()["c"]
        conn.execute(
            """
            INSERT INTO watchlist_panels (id, name, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (panel_id, name.strip() or "Panel", position, now, now),
        )
        conn.commit()
        conn.close()
        return self.get_panel(panel_id) or {}

    def get_panel(self, panel_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM watchlist_panels WHERE id = ?", (panel_id,)).fetchone()
        if not row:
            conn.close()
            return None
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM watchlists WHERE panel_id = ?",
            (panel_id,),
        ).fetchone()["c"]
        conn.close()
        return self._panel_payload(row, count)

    def update_panel(
        self,
        panel_id: str,
        *,
        name: str | None = None,
        position: int | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_panel(panel_id)
        if not existing:
            return None
        conn = self._connect()
        next_name = (name or existing["name"]).strip() or existing["name"]
        next_position = existing["position"] if position is None else position
        conn.execute(
            """
            UPDATE watchlist_panels
            SET name = ?, position = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_name, next_position, _now_utc(), panel_id),
        )
        conn.commit()
        conn.close()
        return self.get_panel(panel_id)

    def delete_panel(self, panel_id: str) -> bool:
        conn = self._connect()
        panel_count = conn.execute("SELECT COUNT(*) AS c FROM watchlist_panels").fetchone()["c"]
        if panel_count <= 1:
            conn.close()
            return False
        fallback = conn.execute(
            """
            SELECT id FROM watchlist_panels
            WHERE id != ?
            ORDER BY position ASC, created_at ASC
            LIMIT 1
            """,
            (panel_id,),
        ).fetchone()
        if not fallback:
            conn.close()
            return False
        fallback_id = fallback["id"]
        conn.execute(
            "UPDATE watchlists SET panel_id = ?, updated_at = ? WHERE panel_id = ?",
            (fallback_id, _now_utc(), panel_id),
        )
        cur = conn.execute("DELETE FROM watchlist_panels WHERE id = ?", (panel_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted

    def default_panel_id(self) -> str:
        conn = self._connect()
        row = conn.execute(
            "SELECT id FROM watchlist_panels ORDER BY position ASC, created_at ASC LIMIT 1"
        ).fetchone()
        conn.close()
        if not row:
            return self.create_panel("Default")["id"]
        return row["id"]

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
            item = self._symbol_payload(row)
            by_watchlist.setdefault(dict(row)["watchlist_id"], []).append(item)

        out: list[dict[str, Any]] = []
        for row in rows:
            wl = dict(row)
            broker = str(wl.get("broker") or "angel").lower()
            env = str(wl.get("account_env") or ("demo" if broker == "etoro" else "live"))
            symbols_for_wl = by_watchlist.get(wl["id"], [])
            if broker == "etoro":
                symbols_for_wl = [
                    self._repair_numeric_etoro_symbol(item, account_env=env)
                    for item in symbols_for_wl
                ]
            out.append(self._watchlist_payload(row, symbols_for_wl))
        return out

    @staticmethod
    def _symbol_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "symboltoken": data["symboltoken"],
            "tradingsymbol": data["tradingsymbol"],
            "exchange": data["exchange"],
            "symbol": data.get("symbol") or data["tradingsymbol"],
            "internal_asset_class_name": data.get("internal_asset_class_name"),
            "instrument_display_name": data.get("instrument_display_name"),
            "logo35x35": data.get("logo35x35"),
            "logo50x50": data.get("logo50x50"),
            "logo150x150": data.get("logo150x150"),
            "raw_metadata_json": data.get("raw_metadata_json"),
            "metadata_updated_at": data.get("metadata_updated_at"),
        }

    def _repair_numeric_etoro_symbol(
        self,
        payload: dict[str, Any],
        *,
        account_env: str,
    ) -> dict[str, Any]:
        from brokers.etoro.adapters.portfolio import (
            _is_numeric_symbol,
            coalesce_etoro_display_name,
            coalesce_etoro_tradingsymbol,
        )

        tradingsymbol = str(payload.get("tradingsymbol") or "").strip()
        if not _is_numeric_symbol(tradingsymbol):
            return payload

        match: dict[str, Any] = dict(payload)
        raw_json = payload.get("raw_metadata_json")
        if raw_json:
            try:
                raw = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
                if isinstance(raw, dict):
                    match.update(raw)
                    match.setdefault("raw_metadata", raw.get("raw") or raw)
            except (TypeError, json.JSONDecodeError):
                pass

        try:
            from control_plane.etoro_db import get_etoro_db

            cached = get_etoro_db().find_by_instrument_id(account_env, tradingsymbol)
            if cached:
                match.update(cached)
        except Exception:
            pass

        resolved = coalesce_etoro_tradingsymbol(match, fallback="")
        if _is_numeric_symbol(resolved):
            display = str(payload.get("instrument_display_name") or "").strip()
            if display and not _is_numeric_symbol(display):
                return {
                    **payload,
                    "symbol": display,
                }
            return payload

        display_name = coalesce_etoro_display_name(match, resolved)
        conn = self._connect()
        conn.execute(
            """
            UPDATE watchlist_symbols
            SET tradingsymbol = ?, symbol = ?
            WHERE id = ?
            """,
            (resolved, display_name, payload["id"]),
        )
        conn.commit()
        conn.close()
        return {
            **payload,
            "tradingsymbol": resolved,
            "symbol": display_name,
            "instrument_display_name": payload.get("instrument_display_name") or display_name,
        }

    def create_watchlist(
        self,
        name: str,
        *,
        broker: str = "angel",
        account_env: str | None = None,
        panel_id: str | None = None,
    ) -> dict[str, Any]:
        watchlist_id = str(uuid.uuid4())
        now = _now_utc()
        broker_name = (broker or "angel").lower()
        env = account_env or ("demo" if broker_name == "etoro" else "live")
        conn = self._connect()
        self._ensure_watchlist_columns(conn)
        self._ensure_panel_schema(conn)
        resolved_panel_id = panel_id or self.default_panel_id()
        position = conn.execute("SELECT COUNT(*) AS c FROM watchlists").fetchone()["c"]
        conn.execute(
            """
            INSERT INTO watchlists (id, name, position, broker, account_env, panel_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (watchlist_id, name.strip() or "Watchlist", position, broker_name, env, resolved_panel_id, now, now),
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
        wl = dict(row)
        broker = str(wl.get("broker") or "angel").lower()
        env = str(wl.get("account_env") or ("demo" if broker == "etoro" else "live"))
        symbol_payloads = [self._symbol_payload(item) for item in symbols]
        if broker == "etoro":
            symbol_payloads = [
                self._repair_numeric_etoro_symbol(item, account_env=env)
                for item in symbol_payloads
            ]
        return self._watchlist_payload(row, symbol_payloads)

    def update_watchlist(
        self,
        watchlist_id: str,
        *,
        name: str | None = None,
        broker: str | None = None,
        account_env: str | None = None,
        panel_id: str | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_watchlist(watchlist_id)
        if not existing:
            return None
        conn = self._connect()
        self._ensure_watchlist_columns(conn)
        self._ensure_panel_schema(conn)
        next_name = (name or existing["name"]).strip() or existing["name"]
        next_broker = (broker or existing.get("broker") or "angel").lower()
        next_env = account_env or existing.get("account_env") or (
            "demo" if next_broker == "etoro" else "live"
        )
        next_panel_id = panel_id or existing.get("panel_id") or self.default_panel_id()
        conn.execute(
            """
            UPDATE watchlists
            SET name = ?, broker = ?, account_env = ?, panel_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_name, next_broker, next_env, next_panel_id, _now_utc(), watchlist_id),
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
        internal_asset_class_name: str | None = None,
        instrument_display_name: str | None = None,
        logo35x35: str | None = None,
        logo50x50: str | None = None,
        logo150x150: str | None = None,
        raw_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not self.get_watchlist(watchlist_id):
            return None
        watchlist = self.get_watchlist(watchlist_id)
        if not watchlist:
            return None
        symbol_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        self._ensure_symbol_metadata_columns(conn)
        position = conn.execute(
            "SELECT COUNT(*) AS c FROM watchlist_symbols WHERE watchlist_id = ?",
            (watchlist_id,),
        ).fetchone()["c"]
        has_metadata = any((
            internal_asset_class_name,
            instrument_display_name,
            logo35x35,
            logo50x50,
            logo150x150,
            raw_metadata,
        ))
        raw_metadata_json = json.dumps(raw_metadata, separators=(",", ":")) if raw_metadata else None
        metadata_updated_at = now if has_metadata else None
        conn.execute(
            """
            INSERT OR IGNORE INTO watchlist_symbols
                (
                    id, watchlist_id, symboltoken, tradingsymbol, exchange, symbol,
                    internal_asset_class_name, instrument_display_name,
                    logo35x35, logo50x50, logo150x150, raw_metadata_json,
                    metadata_updated_at, position, created_at
                )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                symbol_id,
                watchlist_id,
                str(symboltoken),
                tradingsymbol.strip().upper(),
                (exchange or "NSE").upper(),
                (symbol or tradingsymbol).strip().upper(),
                internal_asset_class_name,
                instrument_display_name,
                logo35x35,
                logo50x50,
                logo150x150,
                raw_metadata_json,
                metadata_updated_at,
                position,
                now,
            ),
        )
        if has_metadata:
            conn.execute(
                """
                UPDATE watchlist_symbols
                SET
                    internal_asset_class_name = COALESCE(?, internal_asset_class_name),
                    instrument_display_name = COALESCE(?, instrument_display_name),
                    logo35x35 = COALESCE(?, logo35x35),
                    logo50x50 = COALESCE(?, logo50x50),
                    logo150x150 = COALESCE(?, logo150x150),
                    raw_metadata_json = COALESCE(?, raw_metadata_json),
                    metadata_updated_at = ?
                WHERE watchlist_id = ? AND symboltoken = ?
                """,
                (
                    internal_asset_class_name,
                    instrument_display_name,
                    logo35x35,
                    logo50x50,
                    logo150x150,
                    raw_metadata_json,
                    metadata_updated_at,
                    watchlist_id,
                    str(symboltoken),
                ),
            )
        conn.execute(
            "UPDATE watchlists SET updated_at = ? WHERE id = ?",
            (_now_utc(), watchlist_id),
        )
        conn.commit()
        conn.close()
        if str(watchlist.get("broker") or "").lower() == "etoro":
            try:
                from control_plane.etoro_db import get_etoro_db

                get_etoro_db().upsert_from_watchlist_symbol(
                    {
                        "symboltoken": str(symboltoken),
                        "tradingsymbol": tradingsymbol.strip().upper(),
                        "exchange": (exchange or "ETORO").upper(),
                        "symbol": (symbol or tradingsymbol).strip().upper(),
                        "internal_asset_class_name": internal_asset_class_name,
                        "instrument_display_name": instrument_display_name,
                        "logo35x35": logo35x35,
                        "logo50x50": logo50x50,
                        "logo150x150": logo150x150,
                        "raw_metadata_json": raw_metadata_json,
                    },
                    account_env=str(watchlist.get("account_env") or "demo"),
                    source="watchlist",
                )
            except Exception:
                pass
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

    @staticmethod
    def _ticker_root(value: str) -> str:
        text = str(value or "").strip().upper()
        if not text:
            return ""
        return text.split(".", 1)[0].split("-", 1)[0]

    @classmethod
    def _watchlist_ticker_score(cls, tradingsymbol: str, symbol_field: str, ticker: str) -> int:
        """Higher is better. Used to prefer .US/.RTH equities over bare crypto collisions."""
        target = str(ticker or "").strip().upper()
        if not target:
            return 0
        target_root = cls._ticker_root(target)
        ts = str(tradingsymbol or "").strip().upper()
        sym = str(symbol_field or "").strip().upper()
        if not ts and not sym:
            return 0
        # Exact symbol with exchange suffix beats bare ticker collisions (STX crypto vs STX.US).
        if ts == target and ("." in ts or "-" in ts):
            return 100
        if target_root and ts in {f"{target_root}.US", f"{target_root}.RTH"}:
            return 90
        if ts == target or sym == target:
            return 80
        if target_root and ts.startswith(f"{target_root}."):
            return 70
        if target_root and cls._ticker_root(ts) == target_root:
            return 60
        if target_root and cls._ticker_root(sym) == target_root:
            return 50
        return 0

    def find_symbol_by_ticker(
        self,
        *,
        broker: str,
        account_env: str,
        ticker: str,
    ) -> dict[str, Any] | None:
        """Find the best matching symbol across all watchlists for broker+env.

        Returns a dict with watchlist symbol fields plus watchlist_id/name when found.
        """
        broker_name = (broker or "angel").strip().lower()
        env = (account_env or ("demo" if broker_name == "etoro" else "live")).strip().lower()
        query = str(ticker or "").strip()
        if not query:
            return None

        best: dict[str, Any] | None = None
        best_score = 0
        for watchlist in self.list_watchlists():
            wl_broker = str(watchlist.get("broker") or "angel").strip().lower()
            wl_env = str(
                watchlist.get("account_env")
                or ("demo" if wl_broker == "etoro" else "live")
            ).strip().lower()
            if wl_broker != broker_name or wl_env != env:
                continue
            for symbol in watchlist.get("symbols") or []:
                if not isinstance(symbol, dict):
                    continue
                score = self._watchlist_ticker_score(
                    str(symbol.get("tradingsymbol") or ""),
                    str(symbol.get("symbol") or ""),
                    query,
                )
                if score <= best_score:
                    continue
                token = str(symbol.get("symboltoken") or "").strip()
                if not token:
                    continue
                best_score = score
                best = {
                    **symbol,
                    "watchlist_id": watchlist.get("id"),
                    "watchlist_name": watchlist.get("name"),
                    "broker": wl_broker,
                    "account_env": wl_env,
                    "match_score": score,
                }
        return best

    def list_ticker_roots(
        self,
        *,
        broker: str,
        account_env: str | None = None,
    ) -> set[str]:
        """Return normalized ticker roots present on matching watchlists."""
        broker_name = (broker or "angel").strip().lower()
        env = (
            (account_env or ("demo" if broker_name == "etoro" else "live"))
            .strip()
            .lower()
        )
        roots: set[str] = set()
        for watchlist in self.list_watchlists():
            wl_broker = str(watchlist.get("broker") or "angel").strip().lower()
            wl_env = str(
                watchlist.get("account_env")
                or ("demo" if wl_broker == "etoro" else "live")
            ).strip().lower()
            if wl_broker != broker_name or wl_env != env:
                continue
            for symbol in watchlist.get("symbols") or []:
                if not isinstance(symbol, dict):
                    continue
                # Prefer tradingsymbol; only use display "symbol" when it looks like a ticker.
                candidates = [symbol.get("tradingsymbol")]
                display = str(symbol.get("symbol") or "").strip()
                if display and " " not in display and len(display) <= 12:
                    candidates.append(display)
                for raw in candidates:
                    root = self._ticker_root(str(raw or ""))
                    if root:
                        roots.add(root)
        return roots


_store: WatchlistStore | None = None


def get_watchlist_store() -> WatchlistStore:
    global _store
    if _store is None:
        _store = WatchlistStore()
    return _store