import sqlite3
import json
import os
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "manual_robo.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            token TEXT NOT NULL,
            exchange TEXT DEFAULT 'NSE',
            configured_capital REAL NOT NULL,
            daily_profit_target_pct REAL DEFAULT 1.0,
            long_percent REAL NOT NULL,
            short_percent REAL NOT NULL,
            initial_threshold REAL NOT NULL,
            quantity INTEGER NOT NULL,
            status TEXT DEFAULT 'active',
            started_at TEXT NOT NULL,
            stopped_at TEXT,
            total_pnl REAL DEFAULT 0.0
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            order_id TEXT,
            unique_order_id TEXT,
            variety TEXT DEFAULT 'NORMAL',
            transaction_type TEXT NOT NULL,
            order_type TEXT NOT NULL,
            product_type TEXT DEFAULT 'DELIVERY',
            price REAL,
            trigger_price REAL,
            quantity INTEGER NOT NULL,
            status TEXT DEFAULT 'placed',
            role TEXT NOT NULL,
            placed_at TEXT NOT NULL,
            filled_at TEXT,
            filled_price REAL,
            raw_response TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS ltp_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            ltp REAL NOT NULL,
            timestamp TEXT NOT NULL,
            strategy_signal TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
    """)
    conn.commit()
    conn.close()


def now_ist():
    return datetime.now(IST).isoformat()


def create_session(symbol, token, exchange, configured_capital, daily_profit_target_pct,
                   long_percent, short_percent, initial_threshold, quantity):
    conn = get_connection()
    cursor = conn.execute(
        """INSERT INTO sessions (symbol, token, exchange, configured_capital, daily_profit_target_pct,
           long_percent, short_percent, initial_threshold, quantity, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (symbol, token, exchange, configured_capital, daily_profit_target_pct,
         long_percent, short_percent, initial_threshold, quantity, now_ist())
    )
    session_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return session_id


def get_session(session_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_active_sessions():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM sessions WHERE status = 'active'").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_today_sessions():
    today = datetime.now(IST).strftime("%Y-%m-%d")
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE started_at LIKE ?", (f"{today}%",)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_session_status(session_id, status, total_pnl=None):
    conn = get_connection()
    if total_pnl is not None:
        conn.execute(
            "UPDATE sessions SET status = ?, stopped_at = ?, total_pnl = ? WHERE id = ?",
            (status, now_ist(), total_pnl, session_id)
        )
    else:
        conn.execute(
            "UPDATE sessions SET status = ?, stopped_at = ? WHERE id = ?",
            (status, now_ist(), session_id)
        )
    conn.commit()
    conn.close()


def update_session_pnl(session_id, total_pnl):
    conn = get_connection()
    conn.execute("UPDATE sessions SET total_pnl = ? WHERE id = ?", (total_pnl, session_id))
    conn.commit()
    conn.close()


def insert_order(session_id, transaction_type, order_type, role, quantity,
                 price=None, trigger_price=None, variety="NORMAL",
                 product_type="DELIVERY", order_id=None, unique_order_id=None,
                 raw_response=None):
    conn = get_connection()
    cursor = conn.execute(
        """INSERT INTO orders (session_id, order_id, unique_order_id, variety,
           transaction_type, order_type, product_type, price, trigger_price,
           quantity, role, placed_at, raw_response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (session_id, order_id, unique_order_id, variety, transaction_type,
         order_type, product_type, price, trigger_price, quantity, role,
         now_ist(), json.dumps(raw_response) if raw_response else None)
    )
    row_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return row_id


def update_order_status(order_db_id, status, filled_price=None):
    conn = get_connection()
    if filled_price is not None:
        conn.execute(
            "UPDATE orders SET status = ?, filled_at = ?, filled_price = ? WHERE id = ?",
            (status, now_ist(), filled_price, order_db_id)
        )
    else:
        conn.execute("UPDATE orders SET status = ? WHERE id = ?", (status, order_db_id))
    conn.commit()
    conn.close()


def get_orders_for_session(session_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM orders WHERE session_id = ? ORDER BY id", (session_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_pending_orders(session_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM orders WHERE session_id = ? AND status = 'placed'", (session_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def log_ltp(session_id, ltp, signal=None):
    conn = get_connection()
    conn.execute(
        "INSERT INTO ltp_log (session_id, ltp, timestamp, strategy_signal) VALUES (?, ?, ?, ?)",
        (session_id, ltp, now_ist(), signal)
    )
    conn.commit()
    conn.close()


def get_ltp_history(session_id, limit=50):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM ltp_log WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


init_db()
