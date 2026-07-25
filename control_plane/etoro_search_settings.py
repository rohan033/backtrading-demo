"""Persisted eToro stock-search provider (legacy API vs Algolia)."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any, Literal

from control_plane.etoro_search_cache import invalidate_etoro_search_cache

EtoroSearchMode = Literal["legacy", "algolia"]

DB_PATH = __import__("os").path.join(
    __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))),
    "control_plane.db",
)

SETTING_KEY = "etoro_search_mode"
VALID_MODES: frozenset[str] = frozenset({"legacy", "algolia"})

_mode_cache: EtoroSearchMode | None = None


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_db() -> None:
    conn = _connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workspace_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def _normalize_mode(value: str | None) -> EtoroSearchMode:
    mode = str(value or "legacy").strip().lower()
    return "algolia" if mode == "algolia" else "legacy"


class EtoroSearchSettingsStore:
    def __init__(self, db_path: str = DB_PATH) -> None:
        self.db_path = db_path
        _init_db()

    def get_search_mode(self, *, force_refresh: bool = False) -> EtoroSearchMode:
        global _mode_cache
        if not force_refresh and _mode_cache is not None:
            return _mode_cache

        conn = _connect()
        try:
            row = conn.execute(
                "SELECT value FROM workspace_settings WHERE key = ?",
                (SETTING_KEY,),
            ).fetchone()
        finally:
            conn.close()

        mode = _normalize_mode(row["value"] if row else "legacy")
        _mode_cache = mode
        return mode

    def set_search_mode(self, mode: str) -> dict[str, Any]:
        global _mode_cache
        normalized = _normalize_mode(mode)
        if normalized not in VALID_MODES:
            raise ValueError(f"Invalid search mode: {mode}")

        now = _now_utc()
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO workspace_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (SETTING_KEY, normalized, now),
            )
            conn.commit()
        finally:
            conn.close()

        _mode_cache = normalized
        invalidate_etoro_search_cache()
        return {"mode": normalized, "updated_at": now}

    def get_settings_payload(self) -> dict[str, Any]:
        mode = self.get_search_mode()
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT value, updated_at FROM workspace_settings WHERE key = ?",
                (SETTING_KEY,),
            ).fetchone()
        finally:
            conn.close()
        return {
            "mode": mode,
            "updated_at": row["updated_at"] if row else None,
        }


_store: EtoroSearchSettingsStore | None = None


def get_etoro_search_settings_store() -> EtoroSearchSettingsStore:
    global _store
    if _store is None:
        _store = EtoroSearchSettingsStore()
    return _store
