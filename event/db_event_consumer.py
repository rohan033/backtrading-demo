import json
import os
import sqlite3
import time
from pathlib import Path

from logzero import logger
from typing import Dict, Any, Optional, List

_REPO_ROOT = Path(__file__).resolve().parents[1]


def resolve_live_events_db_path() -> str:
    """Shared SQLite path for control plane and live engine event persistence."""
    raw = os.getenv("LIVE_EVENTS_DB", "live_events.db")
    path = Path(raw)
    return str(path if path.is_absolute() else _REPO_ROOT / path)


class DbEventWriter: 
    def __init__(self, db_path: str = "event_logs.db"):
        self.db_path = db_path
        self._init_database()
        logger.info("DB Event Writer initialized")
    
    def _init_database(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Original event logs table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS event_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                order_id TEXT,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Dedicated trading events table for frontend queries
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS trading_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                order_id TEXT NOT NULL,
                unique_order_id TEXT,
                executor_id TEXT,
                action TEXT NOT NULL,
                symbol TEXT,
                token TEXT,
                exchange TEXT,
                entry_price REAL,
                take_profit_price REAL,
                stop_loss_price REAL,
                quantity INTEGER,
                pct_change REAL,
                threshold REAL,
                reason TEXT,
                status TEXT DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_trading_events_timestamp ON trading_events(timestamp)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_trading_events_order_id ON trading_events(order_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_trading_events_executor_id ON trading_events(executor_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_trading_events_symbol ON trading_events(symbol)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_trading_events_action ON trading_events(action)')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS order_lookups (
                order_id TEXT PRIMARY KEY,
                lookup_json TEXT NOT NULL,
                account_env TEXT,
                updated_at REAL NOT NULL
            )
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS order_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id TEXT NOT NULL,
                position_id TEXT NOT NULL,
                position_json TEXT,
                updated_at REAL NOT NULL,
                UNIQUE (order_id, position_id)
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_order_positions_order_id ON order_positions(order_id)')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS order_poll_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                executor_id TEXT NOT NULL,
                order_id TEXT NOT NULL,
                broker TEXT NOT NULL DEFAULT 'etoro',
                account_env TEXT,
                engine_id TEXT,
                status TEXT NOT NULL DEFAULT 'RUNNING',
                poll_interval_seconds REAL NOT NULL DEFAULT 5.0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                last_polled_at REAL,
                fulfilled_at REAL,
                last_lookup_json TEXT,
                fulfillment_reason TEXT,
                UNIQUE (executor_id, order_id)
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_order_poll_jobs_status ON order_poll_jobs(status)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_order_poll_jobs_executor ON order_poll_jobs(executor_id)')

        self._ensure_column(cursor, "order_poll_jobs", "last_remote_update", "TEXT")
        self._ensure_column(cursor, "order_positions", "executor_id", "TEXT")
        self._ensure_column(cursor, "order_positions", "state", "TEXT")
        self._ensure_column(cursor, "order_positions", "remaining_units", "REAL")
        self._ensure_column(cursor, "order_positions", "last_remote_update", "TEXT")
        
        conn.commit()
        conn.close()
        logger.info(f"Database initialized: {self.db_path}")

    @staticmethod
    def _ensure_column(cursor, table: str, column: str, definition: str) -> None:
        cursor.execute(f"PRAGMA table_info({table})")
        existing = {row[1] for row in cursor.fetchall()}
        if column not in existing:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    
    def log_event(self, order_id: Optional[str], action: str, details: Dict[str, Any]):
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Store in original event_logs table
            cursor.execute('''
                INSERT INTO event_logs (timestamp, order_id, action, details)
                VALUES (?, ?, ?, ?)
            ''', (
                time.time(),
                order_id,
                action,
                json.dumps(details)
            ))
            
            # Store in trading_events table for frontend queries
            if action in [
                'BUY_ORDER_PLACED', 'SELL_ORDER_PLACED', 'ORDER_FILLED', 'ORDER_CANCELLED',
                'ORDER_REJECTED', 'POSITION_CLOSED', 'POSITION_OPENED', 'POSITION_UPDATED',
                'POSITION_CLOSE_REQUESTED', 'POSITION_CLOSE_FAILED', 'ORDER_STATUS_UPDATED',
            ]:
                cursor.execute('''
                    INSERT INTO trading_events (
                        timestamp, order_id, unique_order_id, executor_id, action,
                        symbol, token, exchange, entry_price, take_profit_price, 
                        stop_loss_price, quantity, pct_change, threshold, reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    time.time(),
                    order_id,
                    details.get('unique_order_id'),
                    details.get('executor_id'),
                    action,
                    details.get('symbol'),
                    details.get('token'),
                    details.get('exchange'),
                    details.get('entry_price'),
                    details.get('take_profit_price'),
                    details.get('stop_loss_price'),
                    details.get('quantity'),
                    details.get('pct_change'),
                    details.get('threshold'),
                    details.get('reason')
                ))
            
            conn.commit()
            conn.close()
            
            logger.info(f"\033[35m[DB]\033[0m Event persisted: \033[1m{action}\033[0m  order_id={order_id}")
            
        except Exception as e:
            logger.error(f"Failed to log event: {e}")
    
    def query_events(self, 
                     order_id: Optional[str] = None,
                     action: Optional[str] = None,
                     executor_id: Optional[str] = None,
                     start_time: Optional[float] = None,
                     end_time: Optional[float] = None,
                     limit: int = 100) -> List[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            query = "SELECT * FROM event_logs WHERE 1=1"
            params = []
            
            if order_id:
                query += " AND order_id = ?"
                params.append(order_id)
            
            if action:
                query += " AND action = ?"
                params.append(action)

            if executor_id:
                query += " AND json_extract(details, '$.executor_id') = ?"
                params.append(executor_id)
            
            if start_time:
                query += " AND timestamp >= ?"
                params.append(start_time)
            
            if end_time:
                query += " AND timestamp <= ?"
                params.append(end_time)
            
            query += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            
            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            events = []
            for row in rows:
                events.append({
                    'id': row[0],
                    'timestamp': row[1],
                    'order_id': row[2],
                    'action': row[3],
                    'details': json.loads(row[4]) if row[4] else {},
                    'created_at': row[5]
                })
            
            conn.close()
            return events
            
        except Exception as e:
            logger.error(f"Failed to query events: {e}")
            return []
    
    def query_trading_events(self,
                            executor_id: Optional[str] = None,
                            symbol: Optional[str] = None,
                            action: Optional[str] = None,
                            start_time: Optional[float] = None,
                            end_time: Optional[float] = None,
                            limit: int = 100) -> List[Dict[str, Any]]:
        """Query trading events with optimized structure for frontend"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            query = "SELECT * FROM trading_events WHERE 1=1"
            params = []
            
            if executor_id:
                query += " AND executor_id = ?"
                params.append(executor_id)
            
            if symbol:
                query += " AND symbol = ?"
                params.append(symbol)
            
            if action:
                query += " AND action = ?"
                params.append(action)
            
            if start_time:
                query += " AND timestamp >= ?"
                params.append(start_time)
            
            if end_time:
                query += " AND timestamp <= ?"
                params.append(end_time)
            
            query += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            
            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            events = []
            for row in rows:
                events.append({
                    'id': row[0],
                    'timestamp': row[1],
                    'order_id': row[2],
                    'unique_order_id': row[3],
                    'executor_id': row[4],
                    'action': row[5],
                    'symbol': row[6],
                    'token': row[7],
                    'exchange': row[8],
                    'entry_price': row[9],
                    'take_profit_price': row[10],
                    'stop_loss_price': row[11],
                    'quantity': row[12],
                    'pct_change': row[13],
                    'threshold': row[14],
                    'reason': row[15],
                    'status': row[16],
                    'created_at': row[17]
                })
            
            conn.close()
            return events
            
        except Exception as e:
            logger.error(f"Failed to query trading events: {e}")
            return []
    
    def get_active_positions(self) -> List[Dict[str, Any]]:
        """Get currently active positions (buy orders placed without corresponding sell)"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Get latest buy orders for each executor/symbol
            cursor.execute('''
                SELECT te.* FROM trading_events te
                INNER JOIN (
                    SELECT executor_id, symbol, MAX(timestamp) as latest_timestamp
                    FROM trading_events 
                    WHERE action = 'BUY_ORDER_PLACED'
                    GROUP BY executor_id, symbol
                ) latest ON te.executor_id = latest.executor_id 
                    AND te.symbol = latest.symbol 
                    AND te.timestamp = latest.latest_timestamp
                    AND te.action = 'BUY_ORDER_PLACED'
                WHERE NOT EXISTS (
                    SELECT 1 FROM trading_events se 
                    WHERE se.executor_id = te.executor_id 
                    AND se.symbol = te.symbol 
                    AND se.action = 'SELL_ORDER_PLACED'
                    AND se.timestamp > te.timestamp
                )
                ORDER BY te.timestamp DESC
            ''')
            
            rows = cursor.fetchall()
            positions = []
            for row in rows:
                positions.append({
                    'id': row[0],
                    'timestamp': row[1],
                    'order_id': row[2],
                    'unique_order_id': row[3],
                    'executor_id': row[4],
                    'symbol': row[6],
                    'entry_price': row[9],
                    'take_profit_price': row[10],
                    'stop_loss_price': row[11],
                    'quantity': row[12],
                    'pct_change': row[13],
                    'reason': row[15],
                    'status': row[16]
                })
            
            conn.close()
            return positions
            
        except Exception as e:
            logger.error(f"Failed to get active positions: {e}")
            return []
    
    def get_trading_summary(self, executor_id: Optional[str] = None) -> Dict[str, Any]:
        """Get trading summary statistics"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            query = "SELECT action, COUNT(*) as count, SUM(quantity) as total_quantity, AVG(entry_price) as avg_price FROM trading_events WHERE 1=1"
            params = []
            
            if executor_id:
                query += " AND executor_id = ?"
                params.append(executor_id)
            
            query += " GROUP BY action"
            cursor.execute(query, params)
            
            summary = {}
            for row in cursor.fetchall():
                summary[row[0]] = {
                    'count': row[1],
                    'total_quantity': row[2] or 0,
                    'avg_price': row[3] or 0
                }
            
            conn.close()
            return summary
            
        except Exception as e:
            logger.error(f"Failed to get trading summary: {e}")
            return {}

    def query_event_sessions(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Group persisted trading events by executor for history browsing."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT executor_id,
                       COUNT(*) AS event_count,
                       MIN(timestamp) AS started_at,
                       MAX(timestamp) AS last_at,
                       MAX(symbol) AS symbol
                FROM trading_events
                WHERE executor_id IS NOT NULL AND executor_id != ''
                GROUP BY executor_id
                ORDER BY last_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()
            conn.close()
            return [
                {
                    "id": row[0],
                    "label": row[0],
                    "executor_id": row[0],
                    "event_count": row[1],
                    "started_at": row[2],
                    "last_at": row[3],
                    "symbol": row[4],
                }
                for row in rows
            ]
        except Exception as e:
            logger.error(f"Failed to query event sessions: {e}")
            return []

    def upsert_order_lookup(
        self,
        order_id: str | int,
        lookup: Dict[str, Any],
        *,
        account_env: str | None = None,
        executor_id: str | None = None,
        positions: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Persist a v2 orders:lookup response and linked positions for an order."""
        from brokers.etoro.order_helpers import (
            lookup_last_update,
            normalize_position_executions,
            positions_from_order_lookup,
        )

        order_key = str(order_id)
        updated_at = time.time()
        remote_update = lookup_last_update(lookup)
        normalized_positions = normalize_position_executions(lookup)
        position_rows = positions if positions is not None else positions_from_order_lookup(lookup)
        normalized_by_id = {
            str(item.get("position_id")): item
            for item in normalized_positions
            if item.get("position_id") is not None
        }

        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO order_lookups (order_id, lookup_json, account_env, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(order_id) DO UPDATE SET
                    lookup_json = excluded.lookup_json,
                    account_env = COALESCE(excluded.account_env, order_lookups.account_env),
                    updated_at = excluded.updated_at
                ''',
                (order_key, json.dumps(lookup, default=str), account_env, updated_at),
            )

            for position in position_rows:
                position_id = (
                    position.get("positionID")
                    or position.get("positionId")
                    or position.get("PositionID")
                    or position.get("position_id")
                )
                if position_id is None:
                    continue
                normalized = normalized_by_id.get(str(position_id), {})
                cursor.execute(
                    '''
                    INSERT INTO order_positions (
                        order_id, position_id, position_json, updated_at,
                        executor_id, state, remaining_units, last_remote_update
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(order_id, position_id) DO UPDATE SET
                        position_json = excluded.position_json,
                        updated_at = excluded.updated_at,
                        executor_id = COALESCE(excluded.executor_id, order_positions.executor_id),
                        state = COALESCE(excluded.state, order_positions.state),
                        remaining_units = COALESCE(excluded.remaining_units, order_positions.remaining_units),
                        last_remote_update = COALESCE(excluded.last_remote_update, order_positions.last_remote_update)
                    ''',
                    (
                        order_key,
                        str(position_id),
                        json.dumps(position, default=str),
                        updated_at,
                        executor_id,
                        normalized.get("state"),
                        normalized.get("remaining_units"),
                        remote_update,
                    ),
                )

            conn.commit()
            conn.close()
            logger.info(
                "[DB] Persisted order lookup order_id=%s positions=%d",
                order_key,
                len(position_rows),
            )
        except Exception as e:
            logger.error("Failed to upsert order lookup for %s: %s", order_key, e)

    def get_order_lookup(self, order_id: str | int) -> Optional[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT lookup_json, account_env, updated_at FROM order_lookups WHERE order_id = ?",
                (str(order_id),),
            )
            row = cursor.fetchone()
            conn.close()
            if not row:
                return None
            lookup = json.loads(row[0]) if row[0] else {}
            return {
                "order_id": str(order_id),
                "lookup": lookup,
                "account_env": row[1],
                "updated_at": row[2],
            }
        except Exception as e:
            logger.error("Failed to get order lookup for %s: %s", order_id, e)
            return None

    def get_order_positions(self, order_id: str | int) -> List[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                SELECT position_id, position_json, updated_at
                FROM order_positions
                WHERE order_id = ?
                ORDER BY id
                ''',
                (str(order_id),),
            )
            rows = cursor.fetchall()
            conn.close()
            positions: List[Dict[str, Any]] = []
            for row in rows:
                position = json.loads(row[1]) if row[1] else {}
                positions.append({
                    "position_id": row[0],
                    "position": position,
                    "updated_at": row[2],
                })
            return positions
        except Exception as e:
            logger.error("Failed to get order positions for %s: %s", order_id, e)
            return []

    def enrich_orders_snapshot(self, orders: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        """Attach persisted v2 lookup data to orders when available."""
        enriched: Dict[str, Dict[str, Any]] = {}
        for key, order in orders.items():
            merged = dict(order)
            broker_order_id = order.get("order_id")
            executor_id = order.get("executor_id")
            if broker_order_id:
                positions = self.get_order_positions(broker_order_id)
                if positions:
                    merged["positions"] = positions
                    lookup_row = self.get_order_lookup(broker_order_id)
                    if lookup_row:
                        merged["lookup"] = lookup_row.get("lookup")
                        merged["lookup_updated_at"] = lookup_row.get("updated_at")
            if executor_id and broker_order_id:
                poll_job = self.get_order_poll_job(str(executor_id), broker_order_id)
                if poll_job:
                    merged["poll_job_status"] = poll_job.get("status")
                    merged["poll_job_updated_at"] = poll_job.get("updated_at")
            enriched[key] = merged
        return enriched

    def get_executor_id_for_order(self, order_id: str | int) -> Optional[str]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                SELECT executor_id FROM trading_events
                WHERE order_id = ? AND executor_id IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT 1
                ''',
                (str(order_id),),
            )
            row = cursor.fetchone()
            conn.close()
            return row[0] if row else None
        except Exception as e:
            logger.error("Failed to resolve executor for order %s: %s", order_id, e)
            return None

    def upsert_order_poll_job(
        self,
        *,
        executor_id: str,
        order_id: str | int,
        broker: str = "etoro",
        account_env: str | None = None,
        engine_id: str | None = None,
        status: str = "RUNNING",
        poll_interval_seconds: float = 5.0,
    ) -> None:
        now = time.time()
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO order_poll_jobs (
                    executor_id, order_id, broker, account_env, engine_id, status,
                    poll_interval_seconds, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(executor_id, order_id) DO UPDATE SET
                    broker = excluded.broker,
                    account_env = COALESCE(excluded.account_env, order_poll_jobs.account_env),
                    engine_id = COALESCE(excluded.engine_id, order_poll_jobs.engine_id),
                    status = excluded.status,
                    poll_interval_seconds = excluded.poll_interval_seconds,
                    updated_at = excluded.updated_at
                ''',
                (
                    executor_id,
                    str(order_id),
                    broker,
                    account_env,
                    engine_id,
                    status,
                    poll_interval_seconds,
                    now,
                    now,
                ),
            )
            conn.commit()
            conn.close()
            logger.info(
                "[DB] Upserted order poll job executor=%s order=%s status=%s",
                executor_id,
                order_id,
                status,
            )
        except Exception as e:
            logger.error("Failed to upsert order poll job: %s", e)

    def set_order_poll_job_status(
        self,
        executor_id: str,
        order_id: str | int,
        status: str,
        *,
        fulfillment_reason: str | None = None,
        lookup: Dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        fulfilled_at = now if status == "FULFILLED" else None
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                UPDATE order_poll_jobs
                SET status = ?, updated_at = ?, fulfilled_at = COALESCE(?, fulfilled_at),
                    fulfillment_reason = COALESCE(?, fulfillment_reason),
                    last_lookup_json = COALESCE(?, last_lookup_json)
                WHERE executor_id = ? AND order_id = ?
                ''',
                (
                    status,
                    now,
                    fulfilled_at,
                    fulfillment_reason,
                    json.dumps(lookup, default=str) if lookup else None,
                    executor_id,
                    str(order_id),
                ),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error("Failed to update order poll job status: %s", e)

    def set_order_poll_last_remote_update(
        self,
        executor_id: str,
        order_id: str | int,
        last_remote_update: str | None,
    ) -> None:
        if not last_remote_update:
            return
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                UPDATE order_poll_jobs
                SET last_remote_update = ?, updated_at = ?
                WHERE executor_id = ? AND order_id = ?
                ''',
                (last_remote_update, time.time(), executor_id, str(order_id)),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error("Failed to update poll job last_remote_update: %s", e)

    def get_executor_positions(self, executor_id: str) -> List[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                SELECT op.* FROM order_positions op
                INNER JOIN order_poll_jobs opj
                    ON opj.order_id = op.order_id
                WHERE opj.executor_id = ? OR op.executor_id = ?
                ORDER BY op.updated_at DESC
                ''',
                (executor_id, executor_id),
            )
            rows = cursor.fetchall()
            colnames = [description[0] for description in cursor.description]
            conn.close()
            positions: List[Dict[str, Any]] = []
            for row in rows:
                item = dict(zip(colnames, row))
                if item.get("position_json"):
                    try:
                        item["position"] = json.loads(item["position_json"])
                    except json.JSONDecodeError:
                        item["position"] = {}
                positions.append(item)
            return positions
        except Exception as e:
            logger.error("Failed to get executor positions for %s: %s", executor_id, e)
            return []

    def touch_order_poll_job(
        self,
        executor_id: str,
        order_id: str | int,
        lookup: Dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                UPDATE order_poll_jobs
                SET last_polled_at = ?, updated_at = ?,
                    last_lookup_json = COALESCE(?, last_lookup_json)
                WHERE executor_id = ? AND order_id = ?
                ''',
                (
                    now,
                    now,
                    json.dumps(lookup, default=str) if lookup else None,
                    executor_id,
                    str(order_id),
                ),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error("Failed to touch order poll job: %s", e)

    def ensure_order_poll_job_running(self, order_id: str | int) -> bool:
        executor_id = self.get_executor_id_for_order(order_id)
        if not executor_id:
            return False
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                '''
                SELECT status FROM order_poll_jobs
                WHERE executor_id = ? AND order_id = ?
                ''',
                (executor_id, str(order_id)),
            )
            row = cursor.fetchone()
            if row is None:
                conn.close()
                self.upsert_order_poll_job(
                    executor_id=executor_id,
                    order_id=order_id,
                    status="RUNNING",
                )
                return True
            if row[0] in {"FULFILLED", "REJECTED"}:
                conn.close()
                return False
            cursor.execute(
                '''
                UPDATE order_poll_jobs
                SET status = 'RUNNING', updated_at = ?
                WHERE executor_id = ? AND order_id = ?
                ''',
                (time.time(), executor_id, str(order_id)),
            )
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            logger.error("Failed to ensure order poll job running: %s", e)
            return False

    def list_order_poll_jobs(
        self,
        *,
        status: str | None = None,
        executor_id: str | None = None,
    ) -> List[Dict[str, Any]]:
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            query = "SELECT * FROM order_poll_jobs WHERE 1=1"
            params: list[Any] = []
            if status:
                query += " AND status = ?"
                params.append(status)
            if executor_id:
                query += " AND executor_id = ?"
                params.append(executor_id)
            query += " ORDER BY updated_at DESC"
            cursor.execute(query, params)
            rows = cursor.fetchall()
            colnames = [description[0] for description in cursor.description]
            conn.close()
            jobs: List[Dict[str, Any]] = []
            for row in rows:
                job = dict(zip(colnames, row))
                if job.get("last_lookup_json"):
                    try:
                        job["last_lookup"] = json.loads(job["last_lookup_json"])
                    except json.JSONDecodeError:
                        job["last_lookup"] = None
                jobs.append(job)
            return jobs
        except Exception as e:
            logger.error("Failed to list order poll jobs: %s", e)
            return []

    def get_order_poll_job(
        self,
        executor_id: str,
        order_id: str | int | None = None,
    ) -> Optional[Dict[str, Any]]:
        jobs = self.list_order_poll_jobs(executor_id=executor_id)
        if not jobs:
            return None
        if order_id is None:
            return jobs[0]
        for job in jobs:
            if str(job.get("order_id")) == str(order_id):
                return job
        return None

    def query_orders_snapshot(self, executor_id: Optional[str] = None, limit: int = 100) -> Dict[str, Dict[str, Any]]:
        """Latest persisted order state keyed by unique_order_id or order_id."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            query = """
                SELECT te.*
                FROM trading_events te
                INNER JOIN (
                    SELECT order_id, MAX(timestamp) AS latest_timestamp
                    FROM trading_events
                    WHERE 1=1
            """
            params: list[Any] = []
            if executor_id:
                query += " AND executor_id = ?"
                params.append(executor_id)
            query += """
                    GROUP BY order_id
                ) latest ON te.order_id = latest.order_id
                    AND te.timestamp = latest.latest_timestamp
                ORDER BY te.timestamp DESC
                LIMIT ?
            """
            params.append(limit)
            cursor.execute(query, params)
            rows = cursor.fetchall()
            conn.close()

            orders: Dict[str, Dict[str, Any]] = {}
            for row in rows:
                unique_order_id = row[3] or row[2]
                action = row[5] or ""
                orders[unique_order_id] = {
                    "executor_id": row[4],
                    "order_id": row[2],
                    "unique_order_id": row[3],
                    "order_type": action.replace("_ORDER_PLACED", "").replace("_", " "),
                    "status": row[16] or action,
                    "symbol": row[6],
                    "quantity": row[12],
                    "entry_price": row[9],
                }
            return self.enrich_orders_snapshot(orders)
        except Exception as e:
            logger.error(f"Failed to query orders snapshot: {e}")
            return {}
