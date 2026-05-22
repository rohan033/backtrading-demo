import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any


DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control_plane.db")


class EngineRegistry:
    """SQLite registry of data-plane engines and their API/WS addresses."""

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
            CREATE TABLE IF NOT EXISTS data_plane_engines (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                broker TEXT NOT NULL,
                symbol TEXT,
                token TEXT,
                strategy_name TEXT,
                account_env TEXT NOT NULL DEFAULT 'live',
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                api_base_url TEXT NOT NULL,
                ws_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'unknown',
                pid INTEGER,
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT,
                started_at TEXT,
                stopped_at TEXT,
                heartbeat_count INTEGER NOT NULL DEFAULT 0,
                last_heartbeat_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_data_plane_engines_status
                ON data_plane_engines(status);
            CREATE INDEX IF NOT EXISTS idx_data_plane_engines_broker_symbol_strategy
                ON data_plane_engines(broker, symbol, strategy_name);
            """
        )
        self._ensure_column(conn, "data_plane_engines", "account_env", "TEXT NOT NULL DEFAULT 'live'")
        self._ensure_column(conn, "data_plane_engines", "started_at", "TEXT")
        self._ensure_column(conn, "data_plane_engines", "stopped_at", "TEXT")
        self._ensure_column(conn, "data_plane_engines", "heartbeat_count", "INTEGER NOT NULL DEFAULT 0")
        self._ensure_column(conn, "data_plane_engines", "last_heartbeat_json", "TEXT")
        conn.commit()
        conn.close()

    @staticmethod
    def _ensure_column(conn, table: str, column: str, definition: str) -> None:
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def ensure_default_engine(self) -> None:
        if self.list_engines():
            return

        self.upsert_engine(
            {
                "id": "local-live-engine",
                "label": "angel-local-live-strategy-default",
                "broker": "angel",
                "symbol": "*",
                "token": "*",
                "strategy_name": "default",
                "account_env": "live",
                "host": "localhost",
                "port": 8080,
                "api_base_url": "http://localhost:8080/api/live",
                "ws_url": "ws://localhost:8080/ws/live",
                "status": "unknown",
            }
        )

    def upsert_engine(self, data: dict[str, Any]) -> dict[str, Any]:
        engine_id = data.get("id") or str(uuid.uuid4())
        now = _now_utc()
        host = data.get("host") or "localhost"
        port = int(data.get("port") or 8080)
        api_base_url = data.get("api_base_url") or f"http://{host}:{port}/api/live"
        ws_url = data.get("ws_url") or f"ws://{host}:{port}/ws/live"
        broker = data.get("broker") or "unknown"
        strategy_name = data.get("strategy_name") or "default"
        account_env = _normalize_env(data.get("account_env"))
        symbol = data.get("symbol")
        label = data.get("label") or f"{broker}-{symbol or '*'}-strategy-{strategy_name}"

        conn = self._connect()
        conn.execute(
            """
            INSERT INTO data_plane_engines (
                id, label, broker, symbol, token, strategy_name, account_env, host, port,
                api_base_url, ws_url, status, pid, metadata_json,
                created_at, updated_at, last_seen_at, started_at, stopped_at,
                heartbeat_count, last_heartbeat_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                label = excluded.label,
                broker = excluded.broker,
                symbol = excluded.symbol,
                token = excluded.token,
                strategy_name = excluded.strategy_name,
                account_env = excluded.account_env,
                host = excluded.host,
                port = excluded.port,
                api_base_url = excluded.api_base_url,
                ws_url = excluded.ws_url,
                status = excluded.status,
                pid = excluded.pid,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at,
                started_at = excluded.started_at,
                stopped_at = excluded.stopped_at,
                heartbeat_count = excluded.heartbeat_count,
                last_heartbeat_json = excluded.last_heartbeat_json
            """,
            (
                engine_id,
                label,
                broker,
                symbol,
                data.get("token"),
                strategy_name,
                account_env,
                host,
                port,
                api_base_url,
                ws_url,
                data.get("status") or "unknown",
                data.get("pid"),
                _json_dumps(data.get("metadata")),
                data.get("created_at") or now,
                now,
                data.get("last_seen_at"),
                data.get("started_at"),
                data.get("stopped_at"),
                int(data.get("heartbeat_count") or 0),
                _json_dumps(data.get("last_heartbeat")),
            ),
        )
        conn.commit()
        conn.close()
        return self.get_engine(engine_id)

    def list_engines(self, status: str | None = None) -> list[dict[str, Any]]:
        conn = self._connect()
        if status:
            rows = conn.execute(
                "SELECT * FROM data_plane_engines WHERE status = ? ORDER BY updated_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM data_plane_engines ORDER BY updated_at DESC").fetchall()
        conn.close()
        return [_row_to_dict(row) for row in rows]

    def get_engine(self, engine_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM data_plane_engines WHERE id = ?", (engine_id,)).fetchone()
        conn.close()
        return _row_to_dict(row) if row else None

    def update_engine(self, engine_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_engine(engine_id)
        if not current:
            return None
        merged = {**current, **data, "id": engine_id}
        if "metadata_json" in merged and "metadata" not in merged:
            merged["metadata"] = merged.pop("metadata_json")
        return self.upsert_engine(merged)

    def mark_seen(self, engine_id: str, status: str = "running") -> dict[str, Any] | None:
        return self.update_engine(engine_id, {"status": status, "last_seen_at": _now_utc()})

    def record_heartbeat(self, engine_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_engine(engine_id)
        if not current:
            return None

        now = _now_utc()
        status = data.get("status") or "running"
        heartbeat_count = int(current.get("heartbeat_count") or 0) + 1
        metadata = current.get("metadata") or {}
        heartbeat_metadata = data.get("metadata")
        if isinstance(heartbeat_metadata, dict):
            metadata = {**metadata, **heartbeat_metadata}

        update = {
            "status": status,
            "last_seen_at": now,
            "heartbeat_count": heartbeat_count,
            "last_heartbeat": data,
            "metadata": metadata,
        }
        if data.get("pid") is not None:
            update["pid"] = data.get("pid")
        if data.get("broker"):
            update["broker"] = data.get("broker")
        if data.get("account_env"):
            update["account_env"] = data.get("account_env")
        if status == "running" and not current.get("started_at"):
            update["started_at"] = now
        if status in {"stopped", "failed"}:
            update["stopped_at"] = now
        return self.update_engine(engine_id, update)

    def mark_stale(self, timeout_seconds: int = 15) -> list[dict[str, Any]]:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)
        stale_engines = []
        for engine in self.list_engines():
            if engine.get("status") not in {"starting", "running"}:
                continue
            last_seen = _parse_datetime(engine.get("last_seen_at") or engine.get("updated_at"))
            if last_seen and last_seen < cutoff:
                updated = self.update_engine(engine["id"], {"status": "stale"})
                if updated:
                    stale_engines.append(updated)
        return stale_engines

    def delete_engine(self, engine_id: str) -> bool:
        conn = self._connect()
        cur = conn.execute("DELETE FROM data_plane_engines WHERE id = ?", (engine_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _normalize_env(value: Any) -> str:
    env = str(value or "live").lower()
    return "demo" if env == "demo" else "live"


def _json_dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, default=str)


def _row_to_dict(row) -> dict[str, Any]:
    result = dict(row)
    if result.get("metadata_json"):
        try:
            result["metadata"] = json.loads(result["metadata_json"])
        except json.JSONDecodeError:
            result["metadata"] = result["metadata_json"]
    else:
        result["metadata"] = None
    result.pop("metadata_json", None)
    if result.get("last_heartbeat_json"):
        try:
            result["last_heartbeat"] = json.loads(result["last_heartbeat_json"])
        except json.JSONDecodeError:
            result["last_heartbeat"] = result["last_heartbeat_json"]
    else:
        result["last_heartbeat"] = None
    result.pop("last_heartbeat_json", None)
    return result
