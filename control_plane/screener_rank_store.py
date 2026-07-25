"""Server-side screener rank snapshots with 24h TTL."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "control_plane.db",
)

TTL_HOURS = 24


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now_utc().isoformat()


def _parse_iso(value: str) -> datetime:
    text = str(value or "").strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    return datetime.fromisoformat(text)


class ScreenerRankStore:
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
            CREATE TABLE IF NOT EXISTS screener_rank_snapshots (
                screener_id TEXT NOT NULL,
                ticker TEXT NOT NULL,
                rank INTEGER NOT NULL,
                snapshot_at TEXT NOT NULL,
                PRIMARY KEY (screener_id, ticker, snapshot_at)
            );

            CREATE INDEX IF NOT EXISTS idx_screener_rank_snapshots_time
                ON screener_rank_snapshots(screener_id, snapshot_at DESC);
            """
        )
        conn.commit()
        conn.close()

    def purge_expired(self, screener_id: str | None = None) -> None:
        cutoff = (_now_utc() - timedelta(hours=TTL_HOURS)).isoformat()
        conn = self._connect()
        if screener_id:
            conn.execute(
                "DELETE FROM screener_rank_snapshots WHERE screener_id = ? AND snapshot_at < ?",
                (screener_id, cutoff),
            )
        else:
            conn.execute(
                "DELETE FROM screener_rank_snapshots WHERE snapshot_at < ?",
                (cutoff,),
            )
        conn.commit()
        conn.close()

    def record_snapshot(self, screener_id: str, rows: list[dict[str, Any]]) -> str:
        """Persist ranks for the current refresh. Returns snapshot timestamp."""
        self.purge_expired(screener_id)
        snapshot_at = _now_iso()
        conn = self._connect()
        for idx, row in enumerate(rows):
            ticker = str(row.get("ticker") or row.get("name") or "").strip().upper()
            if not ticker:
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO screener_rank_snapshots
                    (screener_id, ticker, rank, snapshot_at)
                VALUES (?, ?, ?, ?)
                """,
                (screener_id, ticker, idx + 1, snapshot_at),
            )
        conn.commit()
        conn.close()
        return snapshot_at

    def _snapshot_times(self, screener_id: str) -> list[str]:
        cutoff = (_now_utc() - timedelta(hours=TTL_HOURS)).isoformat()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT DISTINCT snapshot_at
            FROM screener_rank_snapshots
            WHERE screener_id = ? AND snapshot_at >= ?
            ORDER BY snapshot_at DESC
            """,
            (screener_id, cutoff),
        ).fetchall()
        conn.close()
        return [str(row["snapshot_at"]) for row in rows]

    def _ranks_at(self, screener_id: str, snapshot_at: str) -> dict[str, int]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT ticker, rank
            FROM screener_rank_snapshots
            WHERE screener_id = ? AND snapshot_at = ?
            """,
            (screener_id, snapshot_at),
        ).fetchall()
        conn.close()
        return {str(row["ticker"]).upper(): int(row["rank"]) for row in rows}

    def enrich_results(
        self,
        screener_id: str,
        results: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not results:
            return results

        times = self._snapshot_times(screener_id)
        previous_at = times[1] if len(times) > 1 else None
        baseline_at = times[-1] if times else None

        previous_ranks = self._ranks_at(screener_id, previous_at) if previous_at else {}
        baseline_ranks = self._ranks_at(screener_id, baseline_at) if baseline_at else {}

        enriched: list[dict[str, Any]] = []
        for row in results:
            payload = dict(row)
            ticker = str(payload.get("ticker") or "").strip().upper()
            rank = int(payload.get("position") or 0) + 1
            payload["rank"] = rank

            prev_rank = previous_ranks.get(ticker)
            if prev_rank is not None:
                payload["rank_jump"] = prev_rank - rank
            else:
                payload["rank_jump"] = None

            base_rank = baseline_ranks.get(ticker)
            if base_rank is not None and baseline_at != previous_at:
                payload["rank_jump_day"] = base_rank - rank
            elif base_rank is not None and previous_at is None:
                payload["rank_jump_day"] = None
            else:
                payload["rank_jump_day"] = None

            enriched.append(payload)
        return enriched


_store: ScreenerRankStore | None = None


def get_screener_rank_store() -> ScreenerRankStore:
    global _store
    if _store is None:
        _store = ScreenerRankStore()
    return _store
