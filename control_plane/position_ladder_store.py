"""Persistent config + runtime for Positions-tab auto-ladder (server-side)."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db"
)

LADDER_FRACTIONS = (0.35, 0.60, 0.85)
TRIM_FRACTION = 0.25
LEVEL_IDS = ("L1", "L2", "L3")


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_env(account_env: str | None) -> str:
    return "demo" if (account_env or "demo").lower() == "demo" else "live"


class PositionLadderStore:
    def __init__(self, db_path: str = DB_PATH) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS position_ladder_state (
                    account_env TEXT NOT NULL,
                    broker_position_id TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    instrument_id INTEGER,
                    auto_ladder_enabled INTEGER NOT NULL DEFAULT 0,
                    is_buy INTEGER NOT NULL DEFAULT 1,
                    entry_price REAL,
                    entry_units REAL,
                    remaining_fraction REAL NOT NULL DEFAULT 1.0,
                    peak_price REAL,
                    l1_hit INTEGER NOT NULL DEFAULT 0,
                    l2_hit INTEGER NOT NULL DEFAULT 0,
                    l3_hit INTEGER NOT NULL DEFAULT 0,
                    last_hit_price REAL,
                    levels_json TEXT NOT NULL DEFAULT '[]',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (account_env, broker_position_id)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def _payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        levels = data.get("levels_json") or "[]"
        try:
            parsed_levels = json.loads(levels) if isinstance(levels, str) else levels
        except json.JSONDecodeError:
            parsed_levels = []
        return {
            "account_env": data["account_env"],
            "broker_position_id": data["broker_position_id"],
            "ticker": data["ticker"],
            "instrument_id": data.get("instrument_id"),
            "auto_ladder_enabled": bool(data.get("auto_ladder_enabled")),
            "is_buy": bool(data.get("is_buy", 1)),
            "entry_price": float(data["entry_price"]) if data.get("entry_price") is not None else None,
            "entry_units": float(data["entry_units"]) if data.get("entry_units") is not None else None,
            "remaining_fraction": float(data.get("remaining_fraction") or 1.0),
            "peak_price": float(data["peak_price"]) if data.get("peak_price") is not None else None,
            "l1_hit": bool(data.get("l1_hit")),
            "l2_hit": bool(data.get("l2_hit")),
            "l3_hit": bool(data.get("l3_hit")),
            "last_hit_price": float(data["last_hit_price"])
            if data.get("last_hit_price") is not None
            else None,
            "levels": parsed_levels if isinstance(parsed_levels, list) else [],
            "updated_at": data.get("updated_at"),
        }

    def list_for_env(self, account_env: str) -> list[dict[str, Any]]:
        env = _normalize_env(account_env)
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM position_ladder_state WHERE account_env = ?",
            (env,),
        ).fetchall()
        conn.close()
        return [self._payload(row) for row in rows]

    def get(self, account_env: str, broker_position_id: str) -> dict[str, Any] | None:
        env = _normalize_env(account_env)
        conn = self._connect()
        row = conn.execute(
            """
            SELECT * FROM position_ladder_state
            WHERE account_env = ? AND broker_position_id = ?
            """,
            (env, str(broker_position_id)),
        ).fetchone()
        conn.close()
        return self._payload(row) if row else None

    def list_armed(self, account_env: str | None = None) -> list[dict[str, Any]]:
        conn = self._connect()
        if account_env is not None:
            rows = conn.execute(
                """
                SELECT * FROM position_ladder_state
                WHERE account_env = ? AND auto_ladder_enabled = 1
                """,
                (_normalize_env(account_env),),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM position_ladder_state WHERE auto_ladder_enabled = 1"
            ).fetchall()
        conn.close()
        return [self._payload(row) for row in rows]

    def set_auto_ladder(
        self,
        account_env: str,
        broker_position_id: str,
        *,
        enabled: bool,
        ticker: str,
        instrument_id: int | None = None,
        entry_price: float | None = None,
        entry_units: float | None = None,
        is_buy: bool = True,
    ) -> dict[str, Any]:
        env = _normalize_env(account_env)
        now = _now_utc()
        pid = str(broker_position_id)
        ticker_u = str(ticker or "").upper()
        with self._lock:
            conn = self._connect()
            existing = conn.execute(
                """
                SELECT * FROM position_ladder_state
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (env, pid),
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE position_ladder_state SET
                        auto_ladder_enabled = ?,
                        ticker = ?,
                        instrument_id = COALESCE(?, instrument_id),
                        entry_price = COALESCE(?, entry_price),
                        entry_units = COALESCE(?, entry_units),
                        is_buy = ?,
                        updated_at = ?
                    WHERE account_env = ? AND broker_position_id = ?
                    """,
                    (
                        1 if enabled else 0,
                        ticker_u,
                        instrument_id,
                        entry_price,
                        entry_units,
                        1 if is_buy else 0,
                        now,
                        env,
                        pid,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO position_ladder_state (
                        account_env, broker_position_id, ticker, instrument_id,
                        auto_ladder_enabled, is_buy, entry_price, entry_units,
                        remaining_fraction, peak_price,
                        l1_hit, l2_hit, l3_hit, last_hit_price,
                        levels_json, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, 0, 0, 0, NULL, '[]', ?)
                    """,
                    (
                        env,
                        pid,
                        ticker_u,
                        instrument_id,
                        1 if enabled else 0,
                        1 if is_buy else 0,
                        entry_price,
                        entry_units,
                        entry_price,
                        now,
                    ),
                )
            conn.commit()
            row = conn.execute(
                """
                SELECT * FROM position_ladder_state
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (env, pid),
            ).fetchone()
            conn.close()
        return self._payload(row)

    def update_runtime(self, account_env: str, broker_position_id: str, **fields: Any) -> None:
        allowed = {
            "peak_price",
            "entry_units",
            "entry_price",
            "remaining_fraction",
            "l1_hit",
            "l2_hit",
            "l3_hit",
            "last_hit_price",
            "levels_json",
            "instrument_id",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return
        updates["updated_at"] = _now_utc()
        env = _normalize_env(account_env)
        columns = ", ".join(f"{key} = ?" for key in updates)
        with self._lock:
            conn = self._connect()
            conn.execute(
                f"""
                UPDATE position_ladder_state SET {columns}
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (*updates.values(), env, str(broker_position_id)),
            )
            conn.commit()
            conn.close()

    def delete(self, account_env: str, broker_position_id: str) -> None:
        env = _normalize_env(account_env)
        with self._lock:
            conn = self._connect()
            conn.execute(
                """
                DELETE FROM position_ladder_state
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (env, str(broker_position_id)),
            )
            conn.commit()
            conn.close()

    def reset_ladder(
        self,
        account_env: str,
        broker_position_id: str,
        *,
        entry_price: float | None = None,
        entry_units: float | None = None,
        peak_price: float | None = None,
        levels: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Clear hit rungs and re-anchor peak/entry for a fresh ladder session."""
        env = _normalize_env(account_env)
        pid = str(broker_position_id)
        existing = self.get(env, pid)
        if not existing:
            return None

        entry = entry_price if entry_price is not None else existing.get("entry_price")
        units = entry_units if entry_units is not None else existing.get("entry_units")
        peak = peak_price if peak_price is not None else entry
        levels_json = json.dumps(levels if levels is not None else [])
        now = _now_utc()

        with self._lock:
            conn = self._connect()
            conn.execute(
                """
                UPDATE position_ladder_state SET
                    entry_price = COALESCE(?, entry_price),
                    entry_units = COALESCE(?, entry_units),
                    remaining_fraction = 1.0,
                    peak_price = ?,
                    l1_hit = 0,
                    l2_hit = 0,
                    l3_hit = 0,
                    last_hit_price = NULL,
                    levels_json = ?,
                    updated_at = ?
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (entry_price, entry_units, peak, levels_json, now, env, pid),
            )
            conn.commit()
            row = conn.execute(
                """
                SELECT * FROM position_ladder_state
                WHERE account_env = ? AND broker_position_id = ?
                """,
                (env, pid),
            ).fetchone()
            conn.close()
        return self._payload(row) if row else None


_store: PositionLadderStore | None = None


def get_position_ladder_store() -> PositionLadderStore:
    global _store
    if _store is None:
        _store = PositionLadderStore()
    return _store
