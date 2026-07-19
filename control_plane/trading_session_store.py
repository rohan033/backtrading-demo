from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")

SESSION_STATES = frozenset({
    "explore",
    "research",
    "strategy",
    "deploy",
    "monitor",
    "stopped",
})


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, default=str)


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


class TradingSessionStore:
    """Persisted autonomous trading sessions, state log, and user-visible events."""

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
            CREATE TABLE IF NOT EXISTS trading_sessions (
                id TEXT PRIMARY KEY,
                state TEXT NOT NULL DEFAULT 'explore',
                environment TEXT NOT NULL DEFAULT 'paper',
                broker TEXT NOT NULL DEFAULT 'etoro',
                account_env TEXT NOT NULL DEFAULT 'demo',
                max_capital REAL NOT NULL DEFAULT 0,
                profit_target REAL NOT NULL DEFAULT 0,
                symbol TEXT,
                token TEXT,
                exchange TEXT,
                stopped_reason TEXT,
                strategy_type TEXT,
                engine_id TEXT,
                total_pnl REAL NOT NULL DEFAULT 0,
                agent_model TEXT,
                agent_model_params_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_trading_sessions_state
                ON trading_sessions(state, updated_at DESC);

            CREATE TABLE IF NOT EXISTS trading_session_state_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                from_state TEXT,
                to_state TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES trading_sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_trading_session_state_log_session
                ON trading_session_state_log(session_id, id);

            CREATE TABLE IF NOT EXISTS trading_session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES trading_sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_trading_session_events_session
                ON trading_session_events(session_id, id);
            """
        )
        # Backward-compatible columns for older DBs.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(trading_sessions)").fetchall()}
        if "agent_model" not in cols:
            conn.execute("ALTER TABLE trading_sessions ADD COLUMN agent_model TEXT")
        if "agent_model_params_json" not in cols:
            conn.execute("ALTER TABLE trading_sessions ADD COLUMN agent_model_params_json TEXT")
        conn.commit()
        conn.close()

    def _session_row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if not row:
            return None
        keys = set(row.keys())
        return {
            "id": row["id"],
            "state": row["state"],
            "environment": row["environment"],
            "broker": row["broker"],
            "account_env": row["account_env"],
            "max_capital": row["max_capital"],
            "profit_target": row["profit_target"],
            "symbol": row["symbol"],
            "token": row["token"],
            "exchange": row["exchange"],
            "stopped_reason": row["stopped_reason"],
            "strategy_type": row["strategy_type"],
            "engine_id": row["engine_id"],
            "total_pnl": row["total_pnl"],
            "agent_model": row["agent_model"] if "agent_model" in keys else None,
            "agent_model_params": _json_loads(
                row["agent_model_params_json"] if "agent_model_params_json" in keys else None,
                [],
            ),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _event_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "event_type": row["event_type"],
            "payload": _json_loads(row["payload_json"], {}),
            "created_at": row["created_at"],
        }

    def create_session(
        self,
        *,
        broker: str = "etoro",
        account_env: str = "demo",
        max_capital: float = 0,
        profit_target: float = 0,
        symbol: str | None = None,
        token: str | None = None,
        exchange: str | None = None,
        agent_model: str | None = None,
        agent_model_params: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        session_id = str(uuid.uuid4())
        now = _now_utc()
        sym = str(symbol or "").strip() or None
        tok = str(token or "").strip() or None
        exch = str(exchange or "").strip() or None
        env = "live" if (account_env or "demo").lower() == "live" else "demo"
        model = str(agent_model or "").strip() or None
        params = agent_model_params if isinstance(agent_model_params, list) else []
        cleaned_params: list[dict[str, str]] = []
        for row in params:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("id") or "").strip()
            value = str(row.get("value") or "").strip()
            if pid and value:
                cleaned_params.append({"id": pid, "value": value})
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO trading_sessions (
                id, state, environment, broker, account_env,
                max_capital, profit_target, symbol, token, exchange,
                stopped_reason, strategy_type, engine_id, total_pnl,
                agent_model, agent_model_params_json,
                created_at, updated_at
            ) VALUES (?, 'explore', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?)
            """,
            (
                session_id,
                env,
                (broker or "etoro").lower(),
                env,
                float(max_capital or 0),
                float(profit_target or 0),
                sym,
                tok,
                exch,
                model,
                _json_dumps(cleaned_params),
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_session(session_id)  # type: ignore[return-value]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM trading_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        return self._session_row(row)

    def list_sessions(self, *, state: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        conn = self._connect()
        if state:
            rows = conn.execute(
                """
                SELECT * FROM trading_sessions
                WHERE state = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (state, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM trading_sessions
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        conn.close()
        return [self._session_row(row) for row in rows if row]

    def update_session(self, session_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_session(session_id)
        if not current:
            return None
        allowed = {
            "state", "environment", "broker", "account_env", "max_capital", "profit_target",
            "symbol", "token", "exchange", "stopped_reason", "strategy_type", "engine_id", "total_pnl",
        }
        merged = {**current}
        for key, value in patch.items():
            if key in allowed:
                merged[key] = value
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            UPDATE trading_sessions SET
                state = ?, environment = ?, broker = ?, account_env = ?,
                max_capital = ?, profit_target = ?, symbol = ?, token = ?, exchange = ?,
                stopped_reason = ?, strategy_type = ?, engine_id = ?, total_pnl = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                merged["state"],
                merged["environment"],
                merged["broker"],
                merged["account_env"],
                merged["max_capital"],
                merged["profit_target"],
                merged.get("symbol"),
                merged.get("token"),
                merged.get("exchange"),
                merged.get("stopped_reason"),
                merged.get("strategy_type"),
                merged.get("engine_id"),
                merged.get("total_pnl", 0),
                now,
                session_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_session(session_id)

    def append_state_transition(
        self,
        session_id: str,
        *,
        from_state: str | None,
        to_state: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        now = _now_utc()
        conn = self._connect()
        cur = conn.execute(
            """
            INSERT INTO trading_session_state_log (session_id, from_state, to_state, reason, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, from_state, to_state, reason, now),
        )
        log_id = cur.lastrowid
        conn.commit()
        conn.close()
        return {
            "id": log_id,
            "session_id": session_id,
            "from_state": from_state,
            "to_state": to_state,
            "reason": reason,
            "created_at": now,
        }

    def list_state_log(self, session_id: str) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM trading_session_state_log
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()
        conn.close()
        return [
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "from_state": row["from_state"],
                "to_state": row["to_state"],
                "reason": row["reason"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_utc()
        conn = self._connect()
        cur = conn.execute(
            """
            INSERT INTO trading_session_events (session_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, event_type, _json_dumps(payload or {}), now),
        )
        event_id = cur.lastrowid
        conn.execute(
            "UPDATE trading_sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        conn.commit()
        conn.close()
        return {
            "id": event_id,
            "session_id": session_id,
            "event_type": event_type,
            "payload": payload or {},
            "created_at": now,
        }

    def list_events(
        self,
        session_id: str,
        *,
        since_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM trading_session_events
            WHERE session_id = ? AND id > ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (session_id, since_id, limit),
        ).fetchall()
        conn.close()
        return [self._event_row(row) for row in rows]

    def latest_event_id(self, session_id: str) -> int:
        conn = self._connect()
        row = conn.execute(
            "SELECT MAX(id) AS max_id FROM trading_session_events WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        if not row or row["max_id"] is None:
            return 0
        return int(row["max_id"])

    def delete_session(self, session_id: str) -> bool:
        conn = self._connect()
        row = conn.execute(
            "SELECT id FROM trading_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            conn.close()
            return False
        conn.execute(
            "DELETE FROM trading_session_events WHERE session_id = ?",
            (session_id,),
        )
        conn.execute(
            "DELETE FROM trading_session_state_log WHERE session_id = ?",
            (session_id,),
        )
        conn.execute(
            "DELETE FROM trading_sessions WHERE id = ?",
            (session_id,),
        )
        conn.commit()
        conn.close()
        return True
