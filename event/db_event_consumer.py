import json
import sqlite3
import time
from logzero import logger
from typing import Dict, Any, Optional, List

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
        
        conn.commit()
        conn.close()
        logger.info(f"Database initialized: {self.db_path}")
    
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
            if action in ['BUY_ORDER_PLACED', 'SELL_ORDER_PLACED', 'ORDER_FILLED', 'ORDER_CANCELLED']:
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
