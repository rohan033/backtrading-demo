"""Durable store for 1% trading sessions, attempts, and UI-replay events."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")

SESSION_STATES = frozenset({
    "created",
    "verifying_balance",
    "screening",
    "selecting",
    "configuring",
    "placing",
    "monitoring",
    "evaluating",
    "finished",
    "stopped",
})

TERMINAL_STATES = frozenset({"finished", "stopped"})

DEFAULT_CONFIG = {
    "capital": 1000.0,
    "target_pct": 1.0,
    "take_profit_pct": 1.5,
    "stop_loss_pct": 2.0,
    "max_attempts": 3,
    "selection_mode": "deterministic",
    "min_score": 0.0,
    "screener_mode": "auto",
    "query_keys": [],
    "screener_ids": [],
}


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trading_day(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    return current.astimezone(timezone.utc).date().isoformat()


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


def _num(value: Any, default: float | None = None) -> float | None:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_config(raw: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {**DEFAULT_CONFIG, **(raw or {})}
    capital = max(1.0, float(data.get("capital") or DEFAULT_CONFIG["capital"]))
    target_pct = max(0.1, float(data.get("target_pct") or DEFAULT_CONFIG["target_pct"]))
    take_profit_pct = max(0.1, float(data.get("take_profit_pct") or DEFAULT_CONFIG["take_profit_pct"]))
    stop_loss_pct = max(0.1, float(data.get("stop_loss_pct") or DEFAULT_CONFIG["stop_loss_pct"]))
    max_attempts = max(1, min(10, int(data.get("max_attempts") or DEFAULT_CONFIG["max_attempts"])))
    selection_mode = str(data.get("selection_mode") or "deterministic").strip().lower()
    if selection_mode not in {"deterministic", "agent", "hybrid"}:
        selection_mode = "deterministic"
    min_score = max(0.0, float(data.get("min_score") if data.get("min_score") is not None else 0.0))
    screener_mode = str(data.get("screener_mode") or "auto").strip().lower()
    if screener_mode not in {"auto", "manual"}:
        screener_mode = "auto"

    # Import lazily so store init does not require screener_query at import time.
    from control_plane.screener_query import ONE_PERCENT_QUERY_PRESETS

    allowed_keys = set(ONE_PERCENT_QUERY_PRESETS.keys())
    # Legacy keys from earlier presets.
    legacy_key_map = {
        "premarket_momentum": "premarket_gainers",
        "intraday_rel_volume": "top_trending",
        "breakout_continuation": "hot_stocks",
    }
    raw_keys = data.get("query_keys") or []
    if not isinstance(raw_keys, list):
        raw_keys = []
    query_keys: list[str] = []
    for item in raw_keys:
        key = str(item or "").strip()
        key = legacy_key_map.get(key, key)
        if key in allowed_keys and key not in query_keys:
            query_keys.append(key)

    raw_ids = data.get("screener_ids") or []
    if not isinstance(raw_ids, list):
        raw_ids = []
    screener_ids: list[str] = []
    for item in raw_ids:
        sid = str(item or "").strip()
        if sid and sid not in screener_ids:
            screener_ids.append(sid)

    if screener_mode == "manual" and not query_keys and not screener_ids:
        screener_mode = "auto"

    return {
        "capital": capital,
        "target_pct": target_pct,
        "take_profit_pct": take_profit_pct,
        "stop_loss_pct": stop_loss_pct,
        "max_attempts": max_attempts,
        "selection_mode": selection_mode,
        "min_score": min_score,
        "screener_mode": screener_mode,
        "query_keys": query_keys,
        "screener_ids": screener_ids,
        "target_dollars": round(capital * target_pct / 100.0, 2),
    }


class OnePercentSessionStore:
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
            CREATE TABLE IF NOT EXISTS one_percent_sessions (
                id TEXT PRIMARY KEY,
                broker TEXT NOT NULL DEFAULT 'etoro',
                account_env TEXT NOT NULL DEFAULT 'demo',
                trading_day TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'created',
                config_json TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                cumulative_pnl REAL NOT NULL DEFAULT 0,
                target_dollars REAL NOT NULL DEFAULT 10,
                active_attempt_id TEXT,
                active_order_id TEXT,
                active_position_id TEXT,
                active_execution_id TEXT,
                active_symbol TEXT,
                terminal_reason TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_one_percent_sessions_env_day
                ON one_percent_sessions(account_env, trading_day, state);
            CREATE INDEX IF NOT EXISTS idx_one_percent_sessions_state
                ON one_percent_sessions(state, updated_at DESC);

            CREATE TABLE IF NOT EXISTS one_percent_session_attempts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                symbol TEXT,
                tradingsymbol TEXT,
                symboltoken TEXT,
                exchange TEXT,
                candidate_json TEXT,
                capital REAL,
                entry_price REAL,
                exit_price REAL,
                take_profit_pct REAL,
                take_profit_price REAL,
                stop_loss_pct REAL,
                stop_loss_price REAL,
                recovery_amount REAL,
                order_id TEXT,
                position_id TEXT,
                execution_id TEXT,
                quantity REAL,
                realized_pnl REAL,
                realized_pnl_pct REAL,
                outcome TEXT,
                close_reason TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                started_at TEXT NOT NULL,
                finished_at TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(session_id, attempt_number),
                FOREIGN KEY (session_id) REFERENCES one_percent_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_one_percent_attempts_session
                ON one_percent_session_attempts(session_id, attempt_number);

            CREATE TABLE IF NOT EXISTS one_percent_session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                state TEXT,
                payload_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES one_percent_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_one_percent_events_session
                ON one_percent_session_events(session_id, id);
            """
        )
        conn.commit()
        conn.close()

    def _session_row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if not row:
            return None
        config = _json_loads(row["config_json"], DEFAULT_CONFIG)
        return {
            "id": row["id"],
            "broker": row["broker"],
            "account_env": row["account_env"],
            "trading_day": row["trading_day"],
            "state": row["state"],
            "config": config,
            "attempt_count": int(row["attempt_count"] or 0),
            "max_attempts": int(row["max_attempts"] or config.get("max_attempts") or 3),
            "cumulative_pnl": float(row["cumulative_pnl"] or 0),
            "target_dollars": float(row["target_dollars"] or config.get("target_dollars") or 10),
            "active_attempt_id": row["active_attempt_id"],
            "active_order_id": row["active_order_id"],
            "active_position_id": row["active_position_id"],
            "active_execution_id": row["active_execution_id"],
            "active_symbol": row["active_symbol"],
            "terminal_reason": row["terminal_reason"],
            "version": int(row["version"] or 0),
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _attempt_row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "attempt_number": int(row["attempt_number"]),
            "symbol": row["symbol"],
            "tradingsymbol": row["tradingsymbol"],
            "symboltoken": row["symboltoken"],
            "exchange": row["exchange"],
            "candidate": _json_loads(row["candidate_json"], {}),
            "capital": row["capital"],
            "entry_price": row["entry_price"],
            "exit_price": row["exit_price"],
            "take_profit_pct": row["take_profit_pct"],
            "take_profit_price": row["take_profit_price"],
            "stop_loss_pct": row["stop_loss_pct"],
            "stop_loss_price": row["stop_loss_price"],
            "recovery_amount": row["recovery_amount"],
            "order_id": row["order_id"],
            "position_id": row["position_id"],
            "execution_id": row["execution_id"],
            "quantity": row["quantity"],
            "realized_pnl": row["realized_pnl"],
            "realized_pnl_pct": row["realized_pnl_pct"],
            "outcome": row["outcome"],
            "close_reason": row["close_reason"],
            "status": row["status"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "updated_at": row["updated_at"],
        }

    def _event_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "event_type": row["event_type"],
            "state": row["state"],
            "payload": _json_loads(row["payload_json"], {}),
            "created_at": row["created_at"],
        }

    def get_active_for_day(
        self,
        *,
        account_env: str,
        trading_day: str | None = None,
    ) -> dict[str, Any] | None:
        env = "live" if (account_env or "demo").lower() == "live" else "demo"
        day = trading_day or _trading_day()
        placeholders = ",".join("?" for _ in TERMINAL_STATES)
        conn = self._connect()
        row = conn.execute(
            f"""
            SELECT * FROM one_percent_sessions
            WHERE account_env = ?
              AND trading_day = ?
              AND state NOT IN ({placeholders})
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (env, day, *TERMINAL_STATES),
        ).fetchone()
        conn.close()
        return self._session_row(row)

    def create_session(
        self,
        *,
        account_env: str = "demo",
        broker: str = "etoro",
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        env = "live" if (account_env or "demo").lower() == "live" else "demo"
        day = _trading_day()
        existing = self.get_active_for_day(account_env=env, trading_day=day)
        if existing:
            raise ValueError(
                f"An active 1% session already exists for {env} on {day}"
            )

        normalized = normalize_config(config)
        session_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO one_percent_sessions (
                id, broker, account_env, trading_day, state, config_json,
                attempt_count, max_attempts, cumulative_pnl, target_dollars,
                version, started_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'created', ?, 0, ?, 0, ?, 0, ?, ?, ?)
            """,
            (
                session_id,
                (broker or "etoro").lower(),
                env,
                day,
                _json_dumps(normalized),
                int(normalized["max_attempts"]),
                float(normalized["target_dollars"]),
                now,
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()
        session = self.get_session(session_id)
        assert session is not None
        self.append_event(
            session_id,
            "session_created",
            state="created",
            payload={
                "config": normalized,
                "account_env": env,
                "trading_day": day,
            },
        )
        return session

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM one_percent_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        return self._session_row(row)

    def list_sessions(self, *, limit: int = 100, account_env: str | None = None) -> list[dict[str, Any]]:
        conn = self._connect()
        if account_env:
            env = "live" if account_env.lower() == "live" else "demo"
            rows = conn.execute(
                """
                SELECT * FROM one_percent_sessions
                WHERE account_env = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (env, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM one_percent_sessions
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        conn.close()
        return [self._session_row(row) for row in rows if row]

    def list_active_sessions(self) -> list[dict[str, Any]]:
        placeholders = ",".join("?" for _ in TERMINAL_STATES)
        conn = self._connect()
        rows = conn.execute(
            f"""
            SELECT * FROM one_percent_sessions
            WHERE state NOT IN ({placeholders})
            ORDER BY updated_at ASC
            """,
            tuple(TERMINAL_STATES),
        ).fetchall()
        conn.close()
        return [self._session_row(row) for row in rows if row]

    def update_session(self, session_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_session(session_id)
        if not current:
            return None
        allowed = {
            "state",
            "attempt_count",
            "cumulative_pnl",
            "active_attempt_id",
            "active_order_id",
            "active_position_id",
            "active_execution_id",
            "active_symbol",
            "terminal_reason",
            "started_at",
            "finished_at",
        }
        merged = {**current}
        for key, value in patch.items():
            if key in allowed:
                merged[key] = value
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            UPDATE one_percent_sessions SET
                state = ?,
                attempt_count = ?,
                cumulative_pnl = ?,
                active_attempt_id = ?,
                active_order_id = ?,
                active_position_id = ?,
                active_execution_id = ?,
                active_symbol = ?,
                terminal_reason = ?,
                started_at = ?,
                finished_at = ?,
                version = version + 1,
                updated_at = ?
            WHERE id = ?
            """,
            (
                merged["state"],
                int(merged["attempt_count"] or 0),
                float(merged["cumulative_pnl"] or 0),
                merged.get("active_attempt_id"),
                merged.get("active_order_id"),
                merged.get("active_position_id"),
                merged.get("active_execution_id"),
                merged.get("active_symbol"),
                merged.get("terminal_reason"),
                merged.get("started_at"),
                merged.get("finished_at"),
                now,
                session_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_session(session_id)

    def set_state(
        self,
        session_id: str,
        state: str,
        *,
        reason: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if state not in SESSION_STATES:
            raise ValueError(f"Invalid state: {state}")
        patch: dict[str, Any] = {"state": state, **(extra or {})}
        if state in TERMINAL_STATES:
            patch.setdefault("finished_at", _now_utc())
            if reason:
                patch["terminal_reason"] = reason
        elif state != "created":
            current = self.get_session(session_id)
            if current and not current.get("started_at"):
                patch["started_at"] = _now_utc()
        return self.update_session(session_id, patch)

    def create_attempt(
        self,
        session_id: str,
        *,
        attempt_number: int,
        symbol: str | None = None,
        tradingsymbol: str | None = None,
        symboltoken: str | None = None,
        exchange: str | None = None,
        candidate: dict[str, Any] | None = None,
        capital: float | None = None,
        entry_price: float | None = None,
        take_profit_pct: float | None = None,
        take_profit_price: float | None = None,
        stop_loss_pct: float | None = None,
        stop_loss_price: float | None = None,
        recovery_amount: float | None = None,
    ) -> dict[str, Any]:
        attempt_id = str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO one_percent_session_attempts (
                id, session_id, attempt_number, symbol, tradingsymbol, symboltoken,
                exchange, candidate_json, capital, entry_price, take_profit_pct,
                take_profit_price, stop_loss_pct, stop_loss_price, recovery_amount,
                status, started_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            (
                attempt_id,
                session_id,
                int(attempt_number),
                symbol,
                tradingsymbol or symbol,
                symboltoken,
                exchange or "ETORO",
                _json_dumps(candidate or {}),
                _num(capital),
                _num(entry_price),
                _num(take_profit_pct),
                _num(take_profit_price),
                _num(stop_loss_pct),
                _num(stop_loss_price),
                _num(recovery_amount),
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()
        self.update_session(
            session_id,
            {
                "attempt_count": attempt_number,
                "active_attempt_id": attempt_id,
                "active_symbol": tradingsymbol or symbol,
            },
        )
        attempt = self.get_attempt(attempt_id)
        assert attempt is not None
        return attempt

    def get_attempt(self, attempt_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM one_percent_session_attempts WHERE id = ?",
            (attempt_id,),
        ).fetchone()
        conn.close()
        return self._attempt_row(row)

    def list_attempts(self, session_id: str) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM one_percent_session_attempts
            WHERE session_id = ?
            ORDER BY attempt_number ASC
            """,
            (session_id,),
        ).fetchall()
        conn.close()
        return [self._attempt_row(row) for row in rows if row]

    def update_attempt(self, attempt_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_attempt(attempt_id)
        if not current:
            return None
        allowed = {
            "symbol",
            "tradingsymbol",
            "symboltoken",
            "exchange",
            "candidate",
            "capital",
            "entry_price",
            "exit_price",
            "take_profit_pct",
            "take_profit_price",
            "stop_loss_pct",
            "stop_loss_price",
            "recovery_amount",
            "order_id",
            "position_id",
            "execution_id",
            "quantity",
            "realized_pnl",
            "realized_pnl_pct",
            "outcome",
            "close_reason",
            "status",
            "finished_at",
        }
        merged = {**current}
        for key, value in patch.items():
            if key in allowed:
                merged[key] = value
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            UPDATE one_percent_session_attempts SET
                symbol = ?, tradingsymbol = ?, symboltoken = ?, exchange = ?,
                candidate_json = ?, capital = ?, entry_price = ?, exit_price = ?,
                take_profit_pct = ?, take_profit_price = ?, stop_loss_pct = ?,
                stop_loss_price = ?, recovery_amount = ?, order_id = ?,
                position_id = ?, execution_id = ?, quantity = ?, realized_pnl = ?,
                realized_pnl_pct = ?, outcome = ?, close_reason = ?, status = ?,
                finished_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                merged.get("symbol"),
                merged.get("tradingsymbol"),
                merged.get("symboltoken"),
                merged.get("exchange"),
                _json_dumps(merged.get("candidate") or {}),
                _num(merged.get("capital")),
                _num(merged.get("entry_price")),
                _num(merged.get("exit_price")),
                _num(merged.get("take_profit_pct")),
                _num(merged.get("take_profit_price")),
                _num(merged.get("stop_loss_pct")),
                _num(merged.get("stop_loss_price")),
                _num(merged.get("recovery_amount")),
                merged.get("order_id"),
                merged.get("position_id"),
                merged.get("execution_id"),
                _num(merged.get("quantity")),
                _num(merged.get("realized_pnl")),
                _num(merged.get("realized_pnl_pct")),
                merged.get("outcome"),
                merged.get("close_reason"),
                merged.get("status") or "open",
                merged.get("finished_at"),
                now,
                attempt_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_attempt(attempt_id)

    def append_event(
        self,
        session_id: str,
        event_type: str,
        *,
        state: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_utc()
        conn = self._connect()
        cur = conn.execute(
            """
            INSERT INTO one_percent_session_events (
                session_id, event_type, state, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, event_type, state, _json_dumps(payload or {}), now),
        )
        event_id = cur.lastrowid
        conn.execute(
            "UPDATE one_percent_sessions SET updated_at = ?, version = version + 1 WHERE id = ?",
            (now, session_id),
        )
        conn.commit()
        conn.close()
        return {
            "id": event_id,
            "session_id": session_id,
            "event_type": event_type,
            "state": state,
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
            SELECT * FROM one_percent_session_events
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
            "SELECT MAX(id) AS max_id FROM one_percent_session_events WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        if not row or row["max_id"] is None:
            return 0
        return int(row["max_id"])

    def get_session_detail(self, session_id: str) -> dict[str, Any] | None:
        session = self.get_session(session_id)
        if not session:
            return None
        return {
            **session,
            "attempts": self.list_attempts(session_id),
            "events": self.list_events(session_id, limit=2000),
        }

    def delete_session(self, session_id: str) -> bool:
        conn = self._connect()
        row = conn.execute(
            "SELECT id FROM one_percent_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            conn.close()
            return False
        conn.execute("DELETE FROM one_percent_session_events WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM one_percent_session_attempts WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM one_percent_sessions WHERE id = ?", (session_id,))
        conn.commit()
        conn.close()
        return True


_store: OnePercentSessionStore | None = None


def get_one_percent_session_store() -> OnePercentSessionStore:
    global _store
    if _store is None:
        _store = OnePercentSessionStore()
    return _store
