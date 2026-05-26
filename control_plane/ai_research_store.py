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


class AiResearchStore:
    """Persisted AI research sessions, chat messages, and flexible action payloads."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_database()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_database(self) -> None:
        conn = self._connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ai_research_sessions (
                session_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New research',
                cursor_agent_id TEXT,
                interaction_mode TEXT NOT NULL DEFAULT 'ask',
                status TEXT NOT NULL DEFAULT 'active',
                summary TEXT,
                actions_json TEXT NOT NULL DEFAULT '[]',
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_message_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_ai_research_sessions_updated
                ON ai_research_sessions(updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_ai_research_sessions_status
                ON ai_research_sessions(status);

            CREATE TABLE IF NOT EXISTS ai_research_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                run_id TEXT,
                tool_name TEXT,
                tool_status TEXT,
                tool_detail TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES ai_research_sessions(session_id)
            );

            CREATE INDEX IF NOT EXISTS idx_ai_research_messages_session
                ON ai_research_messages(session_id, created_at);
            """
        )
        conn.commit()
        conn.close()

    def create_session(
        self,
        *,
        title: str = "New research",
        interaction_mode: str = "ask",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session_id = str(uuid.uuid4())
        now = _now_utc()
        row = {
            "session_id": session_id,
            "title": title.strip() or "New research",
            "cursor_agent_id": None,
            "interaction_mode": interaction_mode if interaction_mode in {"ask", "execute"} else "ask",
            "status": "active",
            "summary": None,
            "actions": [],
            "metadata": metadata or {},
            "created_at": now,
            "updated_at": now,
            "last_message_at": None,
        }
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO ai_research_sessions (
                session_id, title, cursor_agent_id, interaction_mode, status,
                summary, actions_json, metadata_json, created_at, updated_at, last_message_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                row["title"],
                None,
                row["interaction_mode"],
                "active",
                None,
                "[]",
                _json_dumps(row["metadata"]),
                now,
                now,
                None,
            ),
        )
        conn.commit()
        conn.close()
        return row

    def list_sessions(self, *, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        conn = self._connect()
        if status:
            rows = conn.execute(
                """
                SELECT * FROM ai_research_sessions
                WHERE status = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM ai_research_sessions
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        conn.close()
        return [self._session_row(row) for row in rows]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM ai_research_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        return self._session_row(row) if row else None

    def update_session(self, session_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_session(session_id)
        if not current:
            return None

        title = data.get("title", current["title"])
        interaction_mode = data.get("interaction_mode", current["interaction_mode"])
        status = data.get("status", current["status"])
        summary = data.get("summary", current.get("summary"))
        cursor_agent_id = data.get("cursor_agent_id", current.get("cursor_agent_id"))
        metadata = data.get("metadata", current.get("metadata") or {})
        actions = data.get("actions", current.get("actions") or [])
        now = _now_utc()

        conn = self._connect()
        conn.execute(
            """
            UPDATE ai_research_sessions SET
                title = ?,
                cursor_agent_id = ?,
                interaction_mode = ?,
                status = ?,
                summary = ?,
                actions_json = ?,
                metadata_json = ?,
                updated_at = ?,
                last_message_at = COALESCE(?, last_message_at)
            WHERE session_id = ?
            """,
            (
                title,
                cursor_agent_id,
                interaction_mode,
                status,
                summary,
                _json_dumps(actions),
                _json_dumps(metadata),
                now,
                data.get("last_message_at"),
                session_id,
            ),
        )
        conn.commit()
        conn.close()
        return self.get_session(session_id)

    def set_cursor_agent_id(self, session_id: str, cursor_agent_id: str | None) -> dict[str, Any] | None:
        return self.update_session(session_id, {"cursor_agent_id": cursor_agent_id})

    def append_message(
        self,
        session_id: str,
        *,
        role: str,
        content: str,
        run_id: str | None = None,
        tool_name: str | None = None,
        tool_status: str | None = None,
        tool_detail: str | None = None,
        metadata: dict[str, Any] | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any] | None:
        if not self.get_session(session_id):
            return None

        msg_id = message_id or str(uuid.uuid4())
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO ai_research_messages (
                id, session_id, role, content, run_id, tool_name, tool_status,
                tool_detail, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                msg_id,
                session_id,
                role,
                content,
                run_id,
                tool_name,
                tool_status,
                tool_detail,
                _json_dumps(metadata),
                now,
            ),
        )
        conn.execute(
            """
            UPDATE ai_research_sessions
            SET updated_at = ?, last_message_at = ?
            WHERE session_id = ?
            """,
            (now, now, session_id),
        )
        conn.commit()
        conn.close()
        return self.get_message(msg_id)

    def list_messages(
        self,
        session_id: str,
        *,
        limit: int = 50,
        before: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 200))
        conn = self._connect()

        if before:
            cursor = conn.execute(
                """
                SELECT created_at FROM ai_research_messages
                WHERE id = ? AND session_id = ?
                """,
                (before, session_id),
            ).fetchone()
            if not cursor:
                conn.close()
                return {"messages": [], "has_more": False, "oldest_id": None}
            rows = conn.execute(
                """
                SELECT * FROM ai_research_messages
                WHERE session_id = ? AND created_at < ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, cursor["created_at"], limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM ai_research_messages
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, limit + 1),
            ).fetchall()

        conn.close()
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        messages = [self._message_row(row) for row in reversed(rows)]
        oldest_id = messages[0]["id"] if messages else None
        return {"messages": messages, "has_more": has_more, "oldest_id": oldest_id}

    def get_message(self, message_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM ai_research_messages WHERE id = ?",
            (message_id,),
        ).fetchone()
        conn.close()
        return self._message_row(row) if row else None

    def upsert_action(self, session_id: str, action: dict[str, Any]) -> dict[str, Any] | None:
        session = self.get_session(session_id)
        if not session:
            return None

        now = _now_utc()
        action_id = str(action.get("id") or uuid.uuid4())
        actions: list[dict[str, Any]] = list(session.get("actions") or [])
        merged = {
            **action,
            "id": action_id,
            "updated_at": now,
            "created_at": action.get("created_at") or now,
        }

        replaced = False
        for index, existing in enumerate(actions):
            if existing.get("id") == action_id:
                actions[index] = {**existing, **merged}
                replaced = True
                break
        if not replaced:
            actions.append(merged)

        updated = self.update_session(session_id, {"actions": actions})
        return updated

    def delete_action(self, session_id: str, action_id: str) -> dict[str, Any] | None:
        session = self.get_session(session_id)
        if not session:
            return None
        actions = [item for item in (session.get("actions") or []) if item.get("id") != action_id]
        return self.update_session(session_id, {"actions": actions})

    def find_research_session_for_execution(
        self,
        execution_id: str,
        engine: dict[str, Any] | None = None,
        *,
        limit: int = 200,
    ) -> str | None:
        sessions = self.list_sessions(limit=limit)
        for session in sessions:
            session_id = str(session.get("session_id") or "")
            if not session_id:
                continue
            for action in session.get("actions") or []:
                payload = action.get("payload") or {}
                if str(payload.get("execution_id") or "") == execution_id:
                    return session_id

        if not engine:
            return None

        metadata = engine.get("metadata") or {}
        config = metadata.get("execution_config") or {}
        executor = metadata.get("executor_payload") or {}
        symbol = str(engine.get("symbol") or config.get("symbol") or "")
        token = str(engine.get("token") or config.get("token") or "")
        broker = str(engine.get("broker") or config.get("broker") or "")
        try:
            close_price = float(executor.get("close_price") or config.get("close_price") or 0)
        except (TypeError, ValueError):
            close_price = 0.0

        if not symbol or not token or not close_price:
            return None

        for session in sessions:
            session_id = str(session.get("session_id") or "")
            if not session_id:
                continue
            for action in session.get("actions") or []:
                payload = action.get("payload") or {}
                if payload.get("execution_id"):
                    continue
                if str(payload.get("symbol") or "") != symbol:
                    continue
                if str(payload.get("token") or "") != token:
                    continue
                payload_broker = str(payload.get("broker") or "")
                if broker and payload_broker and payload_broker != broker:
                    continue
                try:
                    action_close = float(payload.get("close_price") or 0)
                except (TypeError, ValueError):
                    continue
                if abs(action_close - close_price) > 0.01:
                    continue
                return session_id
        return None

    @staticmethod
    def _session_row(row) -> dict[str, Any]:
        data = dict(row)
        data["actions"] = _json_loads(data.pop("actions_json", None), [])
        metadata = data.pop("metadata_json", None)
        data["metadata"] = _json_loads(metadata, None)
        return data

    @staticmethod
    def _message_row(row) -> dict[str, Any]:
        data = dict(row)
        metadata = data.pop("metadata_json", None)
        data["metadata"] = _json_loads(metadata, None)
        return data
