"""SQLite persistence for agentic trading sessions, events, and positions.

Same storage convention as control_plane/screener_store.py (sqlite3 file at
repo root, WAL, row_factory), but in its own DB file so high-frequency event
appends never contend with screener writes.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "agentic_sessions.db",
)

SESSION_STATUSES = ("running", "paused", "stopped")
POSITION_STATES = ("pending_open", "open", "pending_close", "closed", "failed")
EXIT_STATES = ("running", "weakening", "exit")
EVENT_TYPES = (
    "suggestion",
    "entry",
    "exit",
    "trim",
    "state_change",
    "reconciliation",
    "error",
    "stop",
    "info",
)

# States that count against allocated capital / duplicate-ticker guards.
ACTIVE_POSITION_STATES = ("pending_open", "open", "pending_close")


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(raw: Any, fallback: Any) -> Any:
    try:
        value = json.loads(raw) if raw else fallback
        return value if value is not None else fallback
    except Exception:
        return fallback


class AgenticSessionStore:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._write_lock = threading.Lock()
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
            CREATE TABLE IF NOT EXISTS agentic_sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                account_env TEXT NOT NULL DEFAULT 'demo',
                start_balance REAL NOT NULL DEFAULT 0,
                config_json TEXT NOT NULL DEFAULT '{}',
                snapshot_json TEXT NOT NULL DEFAULT '{}',
                started_at TEXT,
                stopped_at TEXT,
                stop_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agentic_session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,
                ticker TEXT,
                text TEXT NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (session_id) REFERENCES agentic_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agentic_events_session
                ON agentic_session_events(session_id, id);

            CREATE TABLE IF NOT EXISTS agentic_session_positions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                ticker TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending_open',
                exit_state TEXT NOT NULL DEFAULT 'running',
                units REAL NOT NULL DEFAULT 0,
                buy_price REAL,
                stop_loss REAL,
                trail_peak REAL,
                current_price REAL,
                realized_pnl REAL NOT NULL DEFAULT 0,
                unrealized_pnl REAL NOT NULL DEFAULT 0,
                intent_id TEXT,
                broker_position_id TEXT,
                opened_at TEXT,
                closed_at TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES agentic_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agentic_positions_session
                ON agentic_session_positions(session_id, state);
            """
        )
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(agentic_sessions)").fetchall()
        }
        if "snapshot_json" not in columns:
            conn.execute(
                "ALTER TABLE agentic_sessions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'"
            )
        conn.commit()
        conn.close()

    # ── Sessions ──

    @staticmethod
    def _session_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": data["id"],
            "name": data["name"],
            "prompt": data.get("prompt"),
            "status": data["status"],
            "account_env": data["account_env"],
            "start_balance": float(data.get("start_balance") or 0.0),
            "config": _loads(data.get("config_json"), {}),
            "snapshot": _loads(data.get("snapshot_json"), {}),
            "started_at": data.get("started_at"),
            "stopped_at": data.get("stopped_at"),
            "stop_reason": data.get("stop_reason"),
            "created_at": data["created_at"],
            "updated_at": data["updated_at"],
        }

    def create_session(
        self,
        *,
        name: str,
        prompt: str | None,
        account_env: str,
        start_balance: float,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = str(uuid.uuid4())
        now = _now_utc()
        with self._write_lock:
            conn = self._connect()
            conn.execute(
                """
                INSERT INTO agentic_sessions (
                    id, name, prompt, status, account_env, start_balance,
                    config_json, started_at, stopped_at, stop_reason,
                    created_at, updated_at
                ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, ?)
                """,
                (
                    session_id,
                    name,
                    prompt,
                    account_env,
                    float(start_balance),
                    json.dumps(config, separators=(",", ":")),
                    now,
                    now,
                    now,
                ),
            )
            conn.commit()
            conn.close()
        return self.get_session(session_id) or {}

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM agentic_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        conn.close()
        return self._session_payload(row) if row else None

    def list_sessions(self) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM agentic_sessions ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return [self._session_payload(row) for row in rows]

    def list_sessions_by_status(self, status: str) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM agentic_sessions WHERE status = ? ORDER BY created_at DESC",
            (status,),
        ).fetchall()
        conn.close()
        return [self._session_payload(row) for row in rows]

    def update_session(self, session_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {
            "name",
            "prompt",
            "status",
            "start_balance",
            "config_json",
            "snapshot_json",
            "started_at",
            "stopped_at",
            "stop_reason",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_session(session_id)
        updates["updated_at"] = _now_utc()
        columns = ", ".join(f"{key} = ?" for key in updates)
        with self._write_lock:
            conn = self._connect()
            conn.execute(
                f"UPDATE agentic_sessions SET {columns} WHERE id = ?",
                (*updates.values(), session_id),
            )
            conn.commit()
            conn.close()
        return self.get_session(session_id)

    def mutate_snapshot(
        self,
        session_id: str,
        mutator: Any,
    ) -> dict[str, Any]:
        """Atomically read-modify-write a session snapshot under the DB write lock."""
        with self._write_lock:
            conn = self._connect()
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT snapshot_json FROM agentic_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is None:
                conn.rollback()
                conn.close()
                raise KeyError(session_id)
            snapshot = _loads(row["snapshot_json"], {})
            updated = mutator(dict(snapshot))
            if updated is not None:
                snapshot = updated
            now = _now_utc()
            conn.execute(
                "UPDATE agentic_sessions SET snapshot_json = ?, updated_at = ? WHERE id = ?",
                (
                    json.dumps(snapshot, separators=(",", ":"), default=str),
                    now,
                    session_id,
                ),
            )
            conn.commit()
            conn.close()
        return snapshot

    def stop_session(self, session_id: str, reason: str | None = None) -> dict[str, Any] | None:
        return self.update_session(
            session_id,
            {"status": "stopped", "stopped_at": _now_utc(), "stop_reason": reason},
        )

    def delete_session(self, session_id: str) -> bool:
        with self._write_lock:
            conn = self._connect()
            cur = conn.execute("DELETE FROM agentic_sessions WHERE id = ?", (session_id,))
            conn.commit()
            deleted = cur.rowcount > 0
            conn.close()
        return deleted

    def session_stats(self, session_id: str) -> dict[str, Any]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM agentic_session_positions WHERE session_id = ?",
            (session_id,),
        ).fetchall()
        conn.close()
        trades_placed = 0
        realized = 0.0
        unrealized = 0.0
        invested = 0.0
        wins = 0
        closed = 0
        open_positions = 0
        for row in rows:
            data = dict(row)
            state = data["state"]
            if data.get("opened_at"):
                trades_placed += 1
            realized += float(data.get("realized_pnl") or 0.0)
            if state in ("open", "pending_close"):
                open_positions += 1
                unrealized += float(data.get("unrealized_pnl") or 0.0)
                invested += float(data.get("units") or 0.0) * float(data.get("buy_price") or 0.0)
            elif state == "pending_open":
                invested += float(data.get("units") or 0.0) * float(data.get("buy_price") or 0.0)
            elif state == "closed":
                closed += 1
                if float(data.get("realized_pnl") or 0.0) > 0:
                    wins += 1
        return {
            "trades_placed": trades_placed,
            "realized_pnl": round(realized, 4),
            "unrealized_pnl": round(unrealized, 4),
            "invested": round(invested, 4),
            "win_rate": round(wins / closed, 4) if closed else None,
            "open_positions": open_positions,
        }

    # ── Events ──

    @staticmethod
    def _event_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": int(data["id"]),
            "session_id": data["session_id"],
            "ts": data["ts"],
            "type": data["type"],
            "ticker": data.get("ticker"),
            "text": data["text"],
            "meta": _loads(data.get("meta_json"), {}),
        }

    def add_event(
        self,
        session_id: str,
        type: str,
        text: str,
        *,
        ticker: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_utc()
        with self._write_lock:
            conn = self._connect()
            cur = conn.execute(
                """
                INSERT INTO agentic_session_events (session_id, ts, type, ticker, text, meta_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    now,
                    type,
                    ticker,
                    text,
                    json.dumps(meta or {}, separators=(",", ":"), default=str),
                ),
            )
            event_id = cur.lastrowid
            conn.commit()
            conn.close()
        return {
            "id": int(event_id or 0),
            "session_id": session_id,
            "ts": now,
            "type": type,
            "ticker": ticker,
            "text": text,
            "meta": meta or {},
        }

    def list_events(
        self,
        session_id: str,
        *,
        after_id: int = 0,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM agentic_session_events
            WHERE session_id = ? AND id > ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (session_id, int(after_id), max(1, int(limit))),
        ).fetchall()
        conn.close()
        return [self._event_payload(row) for row in rows]

    # ── Positions ──

    @staticmethod
    def _position_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)

        def _num(key: str) -> float | None:
            value = data.get(key)
            return float(value) if value is not None else None

        return {
            "id": data["id"],
            "session_id": data["session_id"],
            "ticker": data["ticker"],
            "state": data["state"],
            "exit_state": data["exit_state"],
            "units": float(data.get("units") or 0.0),
            "buy_price": _num("buy_price"),
            "stop_loss": _num("stop_loss"),
            "trail_peak": _num("trail_peak"),
            "current_price": _num("current_price"),
            "realized_pnl": float(data.get("realized_pnl") or 0.0),
            "unrealized_pnl": float(data.get("unrealized_pnl") or 0.0),
            "intent_id": data.get("intent_id"),
            "broker_position_id": data.get("broker_position_id"),
            "opened_at": data.get("opened_at"),
            "closed_at": data.get("closed_at"),
            "updated_at": data.get("updated_at"),
        }

    def create_position(
        self,
        session_id: str,
        *,
        ticker: str,
        units: float,
        buy_price: float | None,
        stop_loss: float | None,
        intent_id: str,
        state: str = "pending_open",
    ) -> dict[str, Any]:
        position_id = str(uuid.uuid4())
        now = _now_utc()
        with self._write_lock:
            conn = self._connect()
            conn.execute(
                """
                INSERT INTO agentic_session_positions (
                    id, session_id, ticker, state, exit_state, units, buy_price,
                    stop_loss, trail_peak, current_price, realized_pnl,
                    unrealized_pnl, intent_id, broker_position_id,
                    opened_at, closed_at, updated_at
                ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, NULL, ?)
                """,
                (
                    position_id,
                    session_id,
                    ticker.upper(),
                    state,
                    float(units),
                    buy_price,
                    stop_loss,
                    buy_price,
                    buy_price,
                    intent_id,
                    now,
                ),
            )
            conn.commit()
            conn.close()
        return self.get_position(position_id) or {}

    def get_position(self, position_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM agentic_session_positions WHERE id = ?", (position_id,)
        ).fetchone()
        conn.close()
        return self._position_payload(row) if row else None

    def list_positions(
        self,
        session_id: str,
        *,
        states: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        conn = self._connect()
        if states:
            placeholders = ",".join("?" for _ in states)
            rows = conn.execute(
                f"""
                SELECT * FROM agentic_session_positions
                WHERE session_id = ? AND state IN ({placeholders})
                ORDER BY updated_at DESC
                """,
                (session_id, *states),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM agentic_session_positions
                WHERE session_id = ?
                ORDER BY updated_at DESC
                """,
                (session_id,),
            ).fetchall()
        conn.close()
        return [self._position_payload(row) for row in rows]

    def update_position(self, position_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {
            "state",
            "exit_state",
            "units",
            "buy_price",
            "stop_loss",
            "trail_peak",
            "current_price",
            "realized_pnl",
            "unrealized_pnl",
            "intent_id",
            "broker_position_id",
            "opened_at",
            "closed_at",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_position(position_id)
        updates["updated_at"] = _now_utc()
        columns = ", ".join(f"{key} = ?" for key in updates)
        with self._write_lock:
            conn = self._connect()
            conn.execute(
                f"UPDATE agentic_session_positions SET {columns} WHERE id = ?",
                (*updates.values(), position_id),
            )
            conn.commit()
            conn.close()
        return self.get_position(position_id)

    def active_position_for_ticker(self, session_id: str, ticker: str) -> dict[str, Any] | None:
        """Any pending_open/open/pending_close row for this ticker (idempotency guard)."""
        conn = self._connect()
        placeholders = ",".join("?" for _ in ACTIVE_POSITION_STATES)
        row = conn.execute(
            f"""
            SELECT * FROM agentic_session_positions
            WHERE session_id = ? AND ticker = ? AND state IN ({placeholders})
            LIMIT 1
            """,
            (session_id, ticker.upper(), *ACTIVE_POSITION_STATES),
        ).fetchone()
        conn.close()
        return self._position_payload(row) if row else None

    def open_tickers_for_running_sessions(self) -> set[str]:
        """Tickers held (or in-flight) in any running session — hunter cooldown input."""
        conn = self._connect()
        placeholders = ",".join("?" for _ in ACTIVE_POSITION_STATES)
        rows = conn.execute(
            f"""
            SELECT DISTINCT p.ticker FROM agentic_session_positions p
            JOIN agentic_sessions s ON s.id = p.session_id
            WHERE s.status = 'running' AND p.state IN ({placeholders})
            """,
            ACTIVE_POSITION_STATES,
        ).fetchall()
        conn.close()
        return {str(row["ticker"]).upper() for row in rows}

    def recent_closed_positions(self, session_id: str, limit: int = 20) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM agentic_session_positions
            WHERE session_id = ? AND state = 'closed'
            ORDER BY closed_at DESC
            LIMIT ?
            """,
            (session_id, max(1, int(limit))),
        ).fetchall()
        conn.close()
        return [self._position_payload(row) for row in rows]


_store: AgenticSessionStore | None = None


def get_agentic_session_store() -> AgenticSessionStore:
    global _store
    if _store is None:
        _store = AgenticSessionStore()
    return _store
