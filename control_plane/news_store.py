from __future__ import annotations

import json
import sqlite3
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from control_plane.watchlist_store import DB_PATH


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class NewsCacheEntry:
    cache_key: str
    scope: str
    topic: str
    days: int | None
    items: list[dict[str, Any]]
    item_ids: set[int]
    fetched_at: float
    updated_at: str


class NewsStore:
    """Persist compressed Finnhub news payloads and small notification records."""

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
            CREATE TABLE IF NOT EXISTS news_cache (
                cache_key TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                topic TEXT NOT NULL,
                days INTEGER,
                payload_compressed BLOB NOT NULL,
                item_ids_json TEXT NOT NULL,
                fetched_at REAL NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_news_cache_scope_topic
                ON news_cache(scope, topic);

            CREATE TABLE IF NOT EXISTS news_notifications (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                topic TEXT NOT NULL,
                item_id INTEGER NOT NULL,
                headline TEXT NOT NULL,
                source TEXT,
                url TEXT,
                datetime INTEGER,
                created_at TEXT NOT NULL,
                payload_json TEXT,
                UNIQUE(scope, topic, item_id)
            );

            CREATE INDEX IF NOT EXISTS idx_news_notifications_created
                ON news_notifications(created_at DESC);
            """
        )
        conn.commit()
        conn.close()

    @staticmethod
    def _compress_items(items: list[dict[str, Any]]) -> bytes:
        return zlib.compress(_json_dumps(items).encode("utf-8"))

    @staticmethod
    def _decompress_items(payload: bytes) -> list[dict[str, Any]]:
        try:
            decoded = zlib.decompress(payload).decode("utf-8")
            parsed = json.loads(decoded)
        except (zlib.error, UnicodeDecodeError, json.JSONDecodeError):
            return []
        return parsed if isinstance(parsed, list) else []

    @staticmethod
    def _item_ids(items: list[dict[str, Any]]) -> set[int]:
        ids: set[int] = set()
        for item in items:
            try:
                item_id = int(item.get("id") or 0)
            except (TypeError, ValueError):
                continue
            if item_id > 0:
                ids.add(item_id)
        return ids

    def get_cache(self, cache_key: str) -> NewsCacheEntry | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM news_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        items = self._decompress_items(row["payload_compressed"])
        try:
            ids = {int(value) for value in json.loads(row["item_ids_json"] or "[]")}
        except (TypeError, ValueError, json.JSONDecodeError):
            ids = self._item_ids(items)
        return NewsCacheEntry(
            cache_key=row["cache_key"],
            scope=row["scope"],
            topic=row["topic"],
            days=row["days"],
            items=items,
            item_ids=ids,
            fetched_at=float(row["fetched_at"] or 0),
            updated_at=row["updated_at"],
        )

    def set_cache(
        self,
        *,
        cache_key: str,
        scope: str,
        topic: str,
        items: list[dict[str, Any]],
        fetched_at: float,
        days: int | None = None,
    ) -> NewsCacheEntry:
        now = _now_utc()
        item_ids = sorted(self._item_ids(items))
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO news_cache (
                cache_key, scope, topic, days, payload_compressed,
                item_ids_json, fetched_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                scope = excluded.scope,
                topic = excluded.topic,
                days = excluded.days,
                payload_compressed = excluded.payload_compressed,
                item_ids_json = excluded.item_ids_json,
                fetched_at = excluded.fetched_at,
                updated_at = excluded.updated_at
            """,
            (
                cache_key,
                scope,
                topic,
                days,
                self._compress_items(items),
                _json_dumps(item_ids),
                fetched_at,
                now,
            ),
        )
        conn.commit()
        conn.close()
        return NewsCacheEntry(
            cache_key=cache_key,
            scope=scope,
            topic=topic,
            days=days,
            items=items,
            item_ids=set(item_ids),
            fetched_at=fetched_at,
            updated_at=now,
        )

    def insert_notifications(
        self,
        *,
        scope: str,
        topic: str,
        items: list[dict[str, Any]],
        existing_item_ids: set[int],
    ) -> list[dict[str, Any]]:
        new_items: list[dict[str, Any]] = []
        for item in items:
            try:
                item_id = int(item.get("id") or 0)
            except (TypeError, ValueError):
                continue
            if item_id <= 0 or item_id in existing_item_ids:
                continue
            headline = str(item.get("headline") or "").strip()
            if not headline:
                continue
            new_items.append(item)

        if not new_items:
            return []

        now = _now_utc()
        conn = self._connect()
        notifications: list[dict[str, Any]] = []
        for item in new_items:
            item_id = int(item.get("id") or 0)
            notification_id = str(uuid.uuid4())
            payload_json = _json_dumps(item)
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO news_notifications (
                    id, scope, topic, item_id, headline, source,
                    url, datetime, created_at, payload_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    notification_id,
                    scope,
                    topic,
                    item_id,
                    str(item.get("headline") or "").strip(),
                    item.get("source"),
                    item.get("url"),
                    int(item.get("datetime") or 0),
                    now,
                    payload_json,
                ),
            )
            if cur.rowcount > 0:
                notifications.append(
                    {
                        "id": notification_id,
                        "scope": scope,
                        "topic": topic,
                        "item_id": item_id,
                        "headline": str(item.get("headline") or "").strip(),
                        "source": item.get("source"),
                        "url": item.get("url"),
                        "datetime": int(item.get("datetime") or 0),
                        "created_at": now,
                        "payload": item,
                    }
                )
        conn.commit()
        conn.close()
        return notifications

    def recent_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit or 50), 200))
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM news_notifications
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        ).fetchall()
        conn.close()
        return [self._notification_payload(row) for row in rows]

    @staticmethod
    def _notification_payload(row: sqlite3.Row) -> dict[str, Any]:
        payload: dict[str, Any] | None = None
        try:
            parsed = json.loads(row["payload_json"] or "null")
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = None
        return {
            "id": row["id"],
            "scope": row["scope"],
            "topic": row["topic"],
            "item_id": row["item_id"],
            "headline": row["headline"],
            "source": row["source"],
            "url": row["url"],
            "datetime": row["datetime"],
            "created_at": row["created_at"],
            "payload": payload,
        }


_store: NewsStore | None = None


def get_news_store() -> NewsStore:
    global _store
    if _store is None:
        _store = NewsStore()
    return _store
