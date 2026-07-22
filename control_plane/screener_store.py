"""Persist TradingView screener definitions and cached result rows."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from control_plane.screener_query import (
    ONE_PERCENT_PRESET_UI_KEYS,
    ONE_PERCENT_QUERY_PRESETS,
    PRE_MARKET_GAINERS_DEFINITION,
    PRE_MARKET_GAINERS_NAME,
    PREMARKET_MOVERS_DEFINITION,
    ScreenerDefinition,
    definition_to_dsl,
)

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


class ScreenerStore:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_database()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_database(self) -> None:
        conn = self._connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS screeners (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                definition_json TEXT NOT NULL,
                dsl_text TEXT NOT NULL,
                auto_refresh_seconds INTEGER NOT NULL DEFAULT 0,
                watchlist_id TEXT,
                total_count INTEGER NOT NULL DEFAULT 0,
                refresh_status TEXT NOT NULL DEFAULT 'idle',
                last_refreshed_at TEXT,
                last_error TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS screener_results (
                id TEXT PRIMARY KEY,
                screener_id TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                ticker TEXT NOT NULL,
                name TEXT,
                row_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (screener_id) REFERENCES screeners(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_screener_results_screener
                ON screener_results(screener_id, position);
            """
        )
        conn.commit()
        self._seed_defaults(conn)
        conn.close()

    def _seed_defaults(self, conn: sqlite3.Connection) -> None:
        now = _now_utc()
        rows = conn.execute("SELECT id, name, definition_json FROM screeners").fetchall()
        by_name = {str(row["name"]).strip().lower(): row for row in rows}
        seeds: list[tuple[str, ScreenerDefinition]] = [
            (PRE_MARKET_GAINERS_NAME, PRE_MARKET_GAINERS_DEFINITION),
            ("Pre-market Movers", PREMARKET_MOVERS_DEFINITION),
        ]
        # Built-in 1% / Agent Mode query presets — same defs the session starter uses.
        for key in ONE_PERCENT_PRESET_UI_KEYS:
            preset = ONE_PERCENT_QUERY_PRESETS.get(key) or {}
            definition = preset.get("definition")
            name = str(preset.get("name") or key).strip()
            if not name or not isinstance(definition, ScreenerDefinition):
                continue
            seeds.append((name, definition))
        position = len(rows)
        for name, definition in seeds:
            key = name.strip().lower()
            defn = definition.to_dict()
            dsl = definition_to_dsl(definition)
            existing = by_name.get(key)
            if existing:
                # Keep built-in screeners aligned with the curated definition/columns.
                conn.execute(
                    """
                    UPDATE screeners
                    SET definition_json = ?, dsl_text = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        json.dumps(defn, separators=(",", ":")),
                        dsl,
                        now,
                        existing["id"],
                    ),
                )
                continue
            screener_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO screeners (
                    id, name, definition_json, dsl_text, auto_refresh_seconds,
                    watchlist_id, total_count, refresh_status, last_refreshed_at,
                    last_error, position, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    screener_id,
                    name,
                    json.dumps(defn, separators=(",", ":")),
                    dsl,
                    0,
                    None,
                    0,
                    "idle",
                    None,
                    None,
                    position,
                    now,
                    now,
                ),
            )
            position += 1
            by_name[key] = {"id": screener_id, "name": name}
        conn.commit()

    @staticmethod
    def _result_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        try:
            cells = json.loads(data.get("row_json") or "{}")
        except Exception:
            cells = {}
        return {
            "id": data["id"],
            "position": data["position"],
            "ticker": data["ticker"],
            "name": data.get("name") or cells.get("name") or data["ticker"],
            "cells": cells,
        }

    def _payload(self, conn: sqlite3.Connection, row: sqlite3.Row, *, include_results: bool = True) -> dict[str, Any]:
        data = dict(row)
        try:
            definition = json.loads(data["definition_json"])
        except Exception:
            definition = {}
        results: list[dict[str, Any]] = []
        if include_results:
            result_rows = conn.execute(
                """
                SELECT * FROM screener_results
                WHERE screener_id = ?
                ORDER BY position ASC, created_at ASC
                """,
                (data["id"],),
            ).fetchall()
            results = [self._result_payload(r) for r in result_rows]
        return {
            "id": data["id"],
            "name": data["name"],
            "definition": definition,
            "dsl_text": data["dsl_text"],
            "auto_refresh_seconds": int(data["auto_refresh_seconds"] or 0),
            "watchlist_id": data.get("watchlist_id"),
            "total_count": int(data.get("total_count") or 0),
            "refresh_status": data.get("refresh_status") or "idle",
            "last_refreshed_at": data.get("last_refreshed_at"),
            "last_error": data.get("last_error"),
            "position": int(data.get("position") or 0),
            "created_at": data["created_at"],
            "updated_at": data["updated_at"],
            "results": results,
        }

    def list_screeners(self, *, include_results: bool = False) -> list[dict[str, Any]]:
        conn = self._connect()
        # Re-run seeds so newly added built-in presets appear without a full DB wipe.
        self._seed_defaults(conn)
        rows = conn.execute(
            "SELECT * FROM screeners ORDER BY position ASC, created_at ASC"
        ).fetchall()
        out = [self._payload(conn, row, include_results=include_results) for row in rows]
        conn.close()
        return out

    def get_screener(self, screener_id: str, *, include_results: bool = True) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM screeners WHERE id = ?", (screener_id,)).fetchone()
        if not row:
            conn.close()
            return None
        payload = self._payload(conn, row, include_results=include_results)
        conn.close()
        return payload

    def create_screener(
        self,
        name: str,
        *,
        definition: dict[str, Any] | ScreenerDefinition | None = None,
        dsl_text: str | None = None,
        auto_refresh_seconds: int = 0,
    ) -> dict[str, Any]:
        from control_plane.screener_query import parse_dsl

        if dsl_text and not definition:
            defn = parse_dsl(dsl_text)
        else:
            defn = ScreenerDefinition.from_dict(
                definition.to_dict() if isinstance(definition, ScreenerDefinition) else (definition or {})
            )
        normalized_dsl = definition_to_dsl(defn)
        screener_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        position = conn.execute("SELECT COUNT(*) AS c FROM screeners").fetchone()["c"]
        conn.execute(
            """
            INSERT INTO screeners (
                id, name, definition_json, dsl_text, auto_refresh_seconds,
                watchlist_id, total_count, refresh_status, last_refreshed_at,
                last_error, position, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                screener_id,
                (name or "Screener").strip() or "Screener",
                json.dumps(defn.to_dict(), separators=(",", ":")),
                normalized_dsl,
                max(0, int(auto_refresh_seconds or 0)),
                None,
                0,
                "idle",
                None,
                None,
                position,
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_screener(screener_id) or {}

    def update_screener(
        self,
        screener_id: str,
        *,
        name: str | None = None,
        definition: dict[str, Any] | ScreenerDefinition | None = None,
        dsl_text: str | None = None,
        auto_refresh_seconds: int | None = None,
        watchlist_id: str | None = None,
        clear_watchlist: bool = False,
    ) -> dict[str, Any] | None:
        from control_plane.screener_query import parse_dsl

        existing = self.get_screener(screener_id, include_results=False)
        if not existing:
            return None

        next_name = (name if name is not None else existing["name"]).strip() or existing["name"]
        next_definition = existing["definition"]
        next_dsl = existing["dsl_text"]
        if dsl_text is not None and definition is None:
            defn = parse_dsl(dsl_text)
            next_definition = defn.to_dict()
            next_dsl = definition_to_dsl(defn)
        elif definition is not None:
            defn = ScreenerDefinition.from_dict(
                definition.to_dict() if isinstance(definition, ScreenerDefinition) else definition
            )
            next_definition = defn.to_dict()
            next_dsl = definition_to_dsl(defn)

        next_refresh = existing["auto_refresh_seconds"]
        if auto_refresh_seconds is not None:
            next_refresh = max(0, int(auto_refresh_seconds))

        next_watchlist = existing.get("watchlist_id")
        if clear_watchlist:
            next_watchlist = None
        elif watchlist_id is not None:
            next_watchlist = watchlist_id

        conn = self._connect()
        conn.execute(
            """
            UPDATE screeners
            SET name = ?, definition_json = ?, dsl_text = ?, auto_refresh_seconds = ?,
                watchlist_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_name,
                json.dumps(next_definition, separators=(",", ":")),
                next_dsl,
                next_refresh,
                next_watchlist,
                _now_utc(),
                screener_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_screener(screener_id)

    def delete_screener(self, screener_id: str) -> bool:
        conn = self._connect()
        cur = conn.execute("DELETE FROM screeners WHERE id = ?", (screener_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted

    def set_refresh_status(
        self,
        screener_id: str,
        status: str,
        *,
        error: str | None = None,
    ) -> None:
        conn = self._connect()
        conn.execute(
            """
            UPDATE screeners
            SET refresh_status = ?, last_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, error, _now_utc(), screener_id),
        )
        conn.commit()
        conn.close()

    def replace_results(
        self,
        screener_id: str,
        *,
        rows: list[dict[str, Any]],
        total_count: int,
        error: str | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_screener(screener_id, include_results=False)
        if not existing:
            return None
        now = _now_utc()
        conn = self._connect()
        conn.execute("DELETE FROM screener_results WHERE screener_id = ?", (screener_id,))
        for idx, row in enumerate(rows):
            ticker = str(row.get("ticker") or row.get("name") or "").strip()
            if not ticker:
                continue
            name = str(row.get("name") or ticker)
            conn.execute(
                """
                INSERT INTO screener_results (
                    id, screener_id, position, ticker, name, row_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    screener_id,
                    idx,
                    ticker,
                    name,
                    json.dumps(row, separators=(",", ":")),
                    now,
                ),
            )
        conn.execute(
            """
            UPDATE screeners
            SET total_count = ?, refresh_status = ?, last_refreshed_at = ?,
                last_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                int(total_count),
                "ok" if not error else "error",
                now,
                error,
                now,
                screener_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_screener(screener_id)

    def mark_refresh_failed(self, screener_id: str, error: str) -> dict[str, Any] | None:
        """Keep previous results; only update status/error."""
        conn = self._connect()
        cur = conn.execute(
            """
            UPDATE screeners
            SET refresh_status = ?, last_error = ?, updated_at = ?
            WHERE id = ?
            """,
            ("error", (error or "Refresh failed")[:500], _now_utc(), screener_id),
        )
        conn.commit()
        ok = cur.rowcount > 0
        conn.close()
        if not ok:
            return None
        return self.get_screener(screener_id)


_store: ScreenerStore | None = None


def get_screener_store() -> ScreenerStore:
    global _store
    if _store is None:
        _store = ScreenerStore()
    return _store
