from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "trade_halts.db",
)


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def _parse_us_date(value: str | None) -> str | None:
    """Convert MM/DD/YYYY → YYYY-MM-DD."""
    raw = (value or "").strip()
    if not raw:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def halt_status(resumption_date: str | None, resumption_trade_time: str | None) -> str:
    if (resumption_date or "").strip() or (resumption_trade_time or "").strip():
        return "resumed"
    return "halted"


def make_halt_id(symbol: str, halt_date: str, halt_time: str) -> str:
    return f"{symbol}|{halt_date}|{halt_time}"


class TradeHaltsStore:
    """Persist NASDAQ trade-halt RSS entries and dismissible notifications."""

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
            CREATE TABLE IF NOT EXISTS trade_halts (
                id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                issue_name TEXT,
                market TEXT,
                reason_code TEXT,
                pause_threshold_price TEXT,
                halt_date TEXT,
                halt_time TEXT,
                resumption_date TEXT,
                resumption_quote_time TEXT,
                resumption_trade_time TEXT,
                pub_date TEXT,
                status TEXT NOT NULL,
                halt_day TEXT NOT NULL,
                raw_json TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(symbol, halt_date, halt_time)
            );

            CREATE INDEX IF NOT EXISTS idx_trade_halts_day
                ON trade_halts(halt_day DESC);
            CREATE INDEX IF NOT EXISTS idx_trade_halts_symbol_day
                ON trade_halts(symbol, halt_day DESC);

            CREATE TABLE IF NOT EXISTS trade_halt_notifications (
                id TEXT PRIMARY KEY,
                halt_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                event_type TEXT NOT NULL,
                headline TEXT NOT NULL,
                dismissed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                payload_json TEXT,
                UNIQUE(halt_id, event_type)
            );

            CREATE INDEX IF NOT EXISTS idx_trade_halt_notifications_active
                ON trade_halt_notifications(dismissed, created_at DESC);

            CREATE TABLE IF NOT EXISTS trade_halt_notify_prefs (
                symbol TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trade_halt_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.commit()
        conn.close()

    def get_global_notifications_enabled(self, conn: sqlite3.Connection | None = None) -> bool:
        owns = conn is None
        active = conn or self._connect()
        try:
            row = active.execute(
                "SELECT value FROM trade_halt_settings WHERE key = ?",
                ("notifications_enabled",),
            ).fetchone()
            if row is None:
                return True
            return str(row["value"]).strip().lower() not in {"0", "false", "off", "no"}
        finally:
            if owns:
                active.close()

    def set_global_notifications_enabled(self, enabled: bool) -> dict[str, Any]:
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO trade_halt_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            ("notifications_enabled", "1" if enabled else "0", now),
        )
        if not enabled:
            conn.execute(
                """
                UPDATE trade_halt_notifications
                SET dismissed = 1
                WHERE dismissed = 0
                """
            )
        conn.commit()
        conn.close()
        return {
            "notifications_enabled": bool(enabled),
            "updated_at": now,
        }

    def muted_symbols(self, conn: sqlite3.Connection | None = None) -> set[str]:
        owns = conn is None
        active = conn or self._connect()
        try:
            rows = active.execute(
                "SELECT symbol FROM trade_halt_notify_prefs WHERE enabled = 0"
            ).fetchall()
            return {str(row["symbol"]).upper() for row in rows}
        finally:
            if owns:
                active.close()

    def is_notify_enabled(self, symbol: str, conn: sqlite3.Connection | None = None) -> bool:
        ticker = symbol.strip().upper()
        if not ticker:
            return True
        owns = conn is None
        active = conn or self._connect()
        try:
            row = active.execute(
                "SELECT enabled FROM trade_halt_notify_prefs WHERE symbol = ?",
                (ticker,),
            ).fetchone()
            if row is None:
                return True
            return bool(row["enabled"])
        finally:
            if owns:
                active.close()

    def set_notify_enabled(self, symbol: str, enabled: bool) -> dict[str, Any]:
        ticker = symbol.strip().upper()
        if not ticker:
            raise ValueError("symbol required")
        now = _now_utc()
        conn = self._connect()
        conn.execute(
            """
            INSERT INTO trade_halt_notify_prefs (symbol, enabled, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            """,
            (ticker, 1 if enabled else 0, now),
        )
        if not enabled:
            conn.execute(
                """
                UPDATE trade_halt_notifications
                SET dismissed = 1
                WHERE symbol = ? AND dismissed = 0
                """,
                (ticker,),
            )
        conn.commit()
        conn.close()
        return {"symbol": ticker, "notify_enabled": bool(enabled), "updated_at": now}

    def list_notify_prefs(self) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT symbol, enabled, updated_at
            FROM trade_halt_notify_prefs
            ORDER BY symbol ASC
            """
        ).fetchall()
        conn.close()
        return [
            {
                "symbol": row["symbol"],
                "notify_enabled": bool(row["enabled"]),
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def upsert_halts(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Insert/update halt rows and return newly created notifications."""
        if not entries:
            return []

        now = _now_utc()
        notifications: list[dict[str, Any]] = []
        conn = self._connect()
        try:
            global_enabled = self.get_global_notifications_enabled(conn)
            muted = self.muted_symbols(conn) if global_enabled else set()
            for entry in entries:
                symbol = str(entry.get("symbol") or "").strip().upper()
                halt_date = str(entry.get("halt_date") or "").strip()
                halt_time = str(entry.get("halt_time") or "").strip()
                if not symbol or not halt_date:
                    continue

                halt_id = make_halt_id(symbol, halt_date, halt_time)
                halt_day = _parse_us_date(halt_date) or date.today().isoformat()
                resumption_date = str(entry.get("resumption_date") or "").strip() or None
                resumption_trade_time = (
                    str(entry.get("resumption_trade_time") or "").strip() or None
                )
                status = halt_status(resumption_date, resumption_trade_time)
                payload = {
                    "id": halt_id,
                    "symbol": symbol,
                    "issue_name": entry.get("issue_name"),
                    "market": entry.get("market"),
                    "reason_code": entry.get("reason_code"),
                    "pause_threshold_price": entry.get("pause_threshold_price"),
                    "halt_date": halt_date,
                    "halt_time": halt_time or None,
                    "resumption_date": resumption_date,
                    "resumption_quote_time": (
                        str(entry.get("resumption_quote_time") or "").strip() or None
                    ),
                    "resumption_trade_time": resumption_trade_time,
                    "pub_date": entry.get("pub_date"),
                    "status": status,
                    "halt_day": halt_day,
                }

                existing = conn.execute(
                    "SELECT * FROM trade_halts WHERE id = ?",
                    (halt_id,),
                ).fetchone()

                conn.execute(
                    """
                    INSERT INTO trade_halts (
                        id, symbol, issue_name, market, reason_code,
                        pause_threshold_price, halt_date, halt_time,
                        resumption_date, resumption_quote_time, resumption_trade_time,
                        pub_date, status, halt_day, raw_json, first_seen_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        issue_name = excluded.issue_name,
                        market = excluded.market,
                        reason_code = excluded.reason_code,
                        pause_threshold_price = excluded.pause_threshold_price,
                        resumption_date = excluded.resumption_date,
                        resumption_quote_time = excluded.resumption_quote_time,
                        resumption_trade_time = excluded.resumption_trade_time,
                        pub_date = excluded.pub_date,
                        status = excluded.status,
                        halt_day = excluded.halt_day,
                        raw_json = excluded.raw_json,
                        updated_at = excluded.updated_at
                    """,
                    (
                        halt_id,
                        symbol,
                        payload["issue_name"],
                        payload["market"],
                        payload["reason_code"],
                        payload["pause_threshold_price"],
                        halt_date,
                        halt_time or None,
                        resumption_date,
                        payload["resumption_quote_time"],
                        resumption_trade_time,
                        payload["pub_date"],
                        status,
                        halt_day,
                        _json_dumps(payload),
                        now if existing is None else existing["first_seen_at"],
                        now,
                    ),
                )

                if not global_enabled or symbol in muted:
                    continue

                events: list[str] = []
                if existing is None:
                    events.append("resumed" if status == "resumed" else "halted")
                else:
                    prev_status = existing["status"]
                    if prev_status != "resumed" and status == "resumed":
                        events.append("resumed")

                for event_type in events:
                    notification = self._insert_notification(
                        conn,
                        halt_id=halt_id,
                        symbol=symbol,
                        event_type=event_type,
                        payload=payload,
                        created_at=now,
                    )
                    if notification:
                        notifications.append(notification)
            conn.commit()
        finally:
            conn.close()
        return notifications

    def _insert_notification(
        self,
        conn: sqlite3.Connection,
        *,
        halt_id: str,
        symbol: str,
        event_type: str,
        payload: dict[str, Any],
        created_at: str,
    ) -> dict[str, Any] | None:
        if event_type == "resumed":
            resume_bits = []
            if payload.get("resumption_date"):
                resume_bits.append(str(payload["resumption_date"]))
            if payload.get("resumption_trade_time"):
                resume_bits.append(str(payload["resumption_trade_time"]))
            when = " ".join(resume_bits).strip()
            headline = (
                f"{symbol} trading resumed"
                + (f" ({when})" if when else "")
                + (
                    f" · {payload.get('reason_code')}"
                    if payload.get("reason_code")
                    else ""
                )
            )
        else:
            when = " ".join(
                part
                for part in (payload.get("halt_date"), payload.get("halt_time"))
                if part
            ).strip()
            headline = (
                f"{symbol} trading halted"
                + (f" at {when}" if when else "")
                + (
                    f" · {payload.get('reason_code')}"
                    if payload.get("reason_code")
                    else ""
                )
            )

        notification_id = str(uuid.uuid4())
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO trade_halt_notifications (
                id, halt_id, symbol, event_type, headline,
                dismissed, created_at, payload_json
            )
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                notification_id,
                halt_id,
                symbol,
                event_type,
                headline,
                created_at,
                _json_dumps(payload),
            ),
        )
        if cur.rowcount <= 0:
            return None
        return {
            "id": notification_id,
            "halt_id": halt_id,
            "symbol": symbol,
            "event_type": event_type,
            "headline": headline,
            "dismissed": False,
            "created_at": created_at,
            "payload": payload,
        }

    def list_halts_for_day(self, day: str | None = None) -> list[dict[str, Any]]:
        target = (day or date.today().isoformat()).strip()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT h.*, COALESCE(p.enabled, 1) AS notify_enabled
            FROM trade_halts h
            LEFT JOIN trade_halt_notify_prefs p ON p.symbol = h.symbol
            WHERE h.halt_day = ?
            ORDER BY h.halt_date DESC, h.halt_time DESC, h.symbol ASC
            """,
            (target,),
        ).fetchall()
        conn.close()
        return [self._halt_payload(row) for row in rows]

    def list_all_halts(self) -> list[dict[str, Any]]:
        """Return every stored halt row (current NASDAQ feed snapshot)."""
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT h.*, COALESCE(p.enabled, 1) AS notify_enabled
            FROM trade_halts h
            LEFT JOIN trade_halt_notify_prefs p ON p.symbol = h.symbol
            ORDER BY h.halt_day DESC, h.halt_time DESC, h.symbol ASC
            """
        ).fetchall()
        conn.close()
        return [self._halt_payload(row) for row in rows]

    @staticmethod
    def hot_symbols(
        rows: list[dict[str, Any]],
        *,
        reason_code: str = "LUDP",
        limit: int = 6,
    ) -> list[dict[str, Any]]:
        """Rank symbols by halt count for a reason code (default LUDP)."""
        want = (reason_code or "LUDP").strip().upper()
        counts: dict[str, dict[str, Any]] = {}
        for row in rows:
            code = str(row.get("reason_code") or "").strip().upper()
            if want and code != want:
                continue
            symbol = str(row.get("symbol") or "").strip().upper()
            if not symbol:
                continue
            bucket = counts.get(symbol)
            if bucket is None:
                bucket = {
                    "symbol": symbol,
                    "issue_name": row.get("issue_name"),
                    "halt_count": 0,
                    "halted_count": 0,
                    "resumed_count": 0,
                    "last_status": row.get("status") or "halted",
                    "last_halt_day": row.get("halt_day"),
                    "reason_code": code or want,
                }
                counts[symbol] = bucket
            bucket["halt_count"] = int(bucket["halt_count"]) + 1
            if str(row.get("status") or "").lower() == "resumed":
                bucket["resumed_count"] = int(bucket["resumed_count"]) + 1
            else:
                bucket["halted_count"] = int(bucket["halted_count"]) + 1
                bucket["last_status"] = "halted"
            # Prefer freshest day / currently halted as last_status when mixed.
            day = str(row.get("halt_day") or "")
            prev_day = str(bucket.get("last_halt_day") or "")
            if day >= prev_day:
                bucket["last_halt_day"] = day
                if str(row.get("status") or "").lower() != "resumed":
                    bucket["last_status"] = "halted"
                elif bucket["last_status"] != "halted":
                    bucket["last_status"] = "resumed"
                if row.get("issue_name"):
                    bucket["issue_name"] = row.get("issue_name")

        ranked = sorted(
            counts.values(),
            key=lambda item: (
                -int(item.get("halt_count") or 0),
                -int(item.get("halted_count") or 0),
                str(item.get("symbol") or ""),
            ),
        )
        return ranked[: max(1, min(int(limit or 6), 20))]

    def list_recent_halts(self, *, days: int = 2) -> list[dict[str, Any]]:
        """Return halt rows for the last N calendar days (inclusive of today)."""
        span = max(1, min(int(days or 2), 14))
        start = (date.today() - timedelta(days=span - 1)).isoformat()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT h.*, COALESCE(p.enabled, 1) AS notify_enabled
            FROM trade_halts h
            LEFT JOIN trade_halt_notify_prefs p ON p.symbol = h.symbol
            WHERE h.halt_day >= ?
            ORDER BY h.halt_day DESC, h.halt_time DESC, h.symbol ASC
            """,
            (start,),
        ).fetchall()
        conn.close()
        return [self._halt_payload(row) for row in rows]

    def list_halts_for_symbol(
        self,
        symbol: str,
        *,
        day: str | None = None,
    ) -> list[dict[str, Any]]:
        ticker = symbol.strip().upper()
        conn = self._connect()
        if day:
            target = day.strip()
            rows = conn.execute(
                """
                SELECT h.*, COALESCE(p.enabled, 1) AS notify_enabled
                FROM trade_halts h
                LEFT JOIN trade_halt_notify_prefs p ON p.symbol = h.symbol
                WHERE h.symbol = ? AND h.halt_day = ?
                ORDER BY h.halt_time DESC
                """,
                (ticker, target),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT h.*, COALESCE(p.enabled, 1) AS notify_enabled
                FROM trade_halts h
                LEFT JOIN trade_halt_notify_prefs p ON p.symbol = h.symbol
                WHERE h.symbol = ?
                ORDER BY h.halt_day DESC, h.halt_time DESC
                """,
                (ticker,),
            ).fetchall()
        conn.close()
        return [self._halt_payload(row) for row in rows]

    def active_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.get_global_notifications_enabled():
            return []
        bounded = max(1, min(int(limit or 50), 200))
        muted = self.muted_symbols()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM trade_halt_notifications
            WHERE dismissed = 0
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded,),
        ).fetchall()
        conn.close()
        return [
            self._notification_payload(row)
            for row in rows
            if str(row["symbol"]).upper() not in muted
        ]

    def dismiss_notification(self, notification_id: str) -> bool:
        conn = self._connect()
        cur = conn.execute(
            """
            UPDATE trade_halt_notifications
            SET dismissed = 1
            WHERE id = ? AND dismissed = 0
            """,
            (notification_id,),
        )
        conn.commit()
        changed = cur.rowcount > 0
        conn.close()
        return changed

    def dismiss_all_notifications(self) -> int:
        conn = self._connect()
        cur = conn.execute(
            """
            UPDATE trade_halt_notifications
            SET dismissed = 1
            WHERE dismissed = 0
            """
        )
        deleted = int(cur.rowcount or 0)
        conn.commit()
        conn.close()
        return deleted

    def purge_missing_ids(self, keep_ids: set[str]) -> dict[str, int]:
        """Drop halt rows that are no longer present in the latest feed snapshot."""
        conn = self._connect()
        existing = [row["id"] for row in conn.execute("SELECT id FROM trade_halts").fetchall()]
        stale_ids = [halt_id for halt_id in existing if halt_id not in keep_ids]
        notifications_deleted = 0
        if stale_ids:
            placeholders = ",".join("?" for _ in stale_ids)
            cur = conn.execute(
                f"DELETE FROM trade_halt_notifications WHERE halt_id IN ({placeholders})",
                stale_ids,
            )
            notifications_deleted = int(cur.rowcount or 0)
            cur = conn.execute(
                f"DELETE FROM trade_halts WHERE id IN ({placeholders})",
                stale_ids,
            )
            halts_deleted = int(cur.rowcount or 0)
        else:
            halts_deleted = 0
        conn.commit()
        conn.close()
        return {
            "halts_deleted": halts_deleted,
            "notifications_deleted": notifications_deleted,
        }

    def purge_older_than(self, keep_day: str | None = None) -> dict[str, int]:
        """Remove halt rows (and their notifications) older than keep_day."""
        cutoff = (keep_day or date.today().isoformat()).strip()
        conn = self._connect()
        halt_ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM trade_halts WHERE halt_day < ?",
                (cutoff,),
            ).fetchall()
        ]
        notifications_deleted = 0
        if halt_ids:
            placeholders = ",".join("?" for _ in halt_ids)
            cur = conn.execute(
                f"DELETE FROM trade_halt_notifications WHERE halt_id IN ({placeholders})",
                halt_ids,
            )
            notifications_deleted = int(cur.rowcount or 0)
        cur = conn.execute(
            "DELETE FROM trade_halts WHERE halt_day < ?",
            (cutoff,),
        )
        halts_deleted = int(cur.rowcount or 0)
        cur = conn.execute(
            """
            DELETE FROM trade_halt_notifications
            WHERE halt_id NOT IN (SELECT id FROM trade_halts)
            """
        )
        orphan_notifications = int(cur.rowcount or 0)
        conn.commit()
        conn.close()
        return {
            "halts_deleted": halts_deleted,
            "notifications_deleted": notifications_deleted + orphan_notifications,
        }

    @staticmethod
    def _halt_payload(row: sqlite3.Row) -> dict[str, Any]:
        keys = set(row.keys())
        notify_enabled = True
        if "notify_enabled" in keys:
            notify_enabled = bool(row["notify_enabled"])
        return {
            "id": row["id"],
            "symbol": row["symbol"],
            "issue_name": row["issue_name"],
            "market": row["market"],
            "reason_code": row["reason_code"],
            "pause_threshold_price": row["pause_threshold_price"],
            "halt_date": row["halt_date"],
            "halt_time": row["halt_time"],
            "resumption_date": row["resumption_date"],
            "resumption_quote_time": row["resumption_quote_time"],
            "resumption_trade_time": row["resumption_trade_time"],
            "pub_date": row["pub_date"],
            "status": row["status"],
            "halt_day": row["halt_day"],
            "first_seen_at": row["first_seen_at"],
            "updated_at": row["updated_at"],
            "notify_enabled": notify_enabled,
        }

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
            "halt_id": row["halt_id"],
            "symbol": row["symbol"],
            "event_type": row["event_type"],
            "headline": row["headline"],
            "dismissed": bool(row["dismissed"]),
            "created_at": row["created_at"],
            "payload": payload,
        }


_store: TradeHaltsStore | None = None


def get_trade_halts_store() -> TradeHaltsStore:
    global _store
    if _store is None:
        _store = TradeHaltsStore()
    return _store
