import json
import sqlite3
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from logzero import logger

from brokers.interfaces import OrderActivity


class OrderActivityStore:
    """Broker-agnostic SQLite store for trading sessions, status, and history."""

    def __init__(self, db_path: str = "order_activity.db"):
        self.db_path = db_path
        self._init_database()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_database(self) -> None:
        conn = self._connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS trading_sessions (
                id TEXT PRIMARY KEY,
                label TEXT,
                broker TEXT NOT NULL,
                account_env TEXT,
                strategy_name TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                started_at TEXT NOT NULL,
                stopped_at TEXT,
                config_json TEXT,
                summary_json TEXT
            );

            CREATE TABLE IF NOT EXISTS broker_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                broker TEXT NOT NULL,
                broker_order_id TEXT NOT NULL,
                broker_unique_order_id TEXT,
                broker_position_id TEXT,
                instrument_token TEXT,
                symbol TEXT,
                exchange TEXT,
                side TEXT,
                intent TEXT,
                order_type TEXT,
                status TEXT,
                quantity REAL,
                amount REAL,
                price REAL,
                take_profit_rate REAL,
                stop_loss_rate REAL,
                placed_at TEXT,
                updated_at TEXT NOT NULL,
                raw_json TEXT,
                UNIQUE (session_id, broker, broker_order_id),
                FOREIGN KEY (session_id) REFERENCES trading_sessions(id)
            );

            CREATE TABLE IF NOT EXISTS broker_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                broker TEXT NOT NULL,
                broker_position_id TEXT NOT NULL,
                opening_broker_order_id TEXT,
                instrument_token TEXT,
                symbol TEXT,
                exchange TEXT,
                side TEXT,
                status TEXT,
                units REAL,
                invested_amount REAL,
                open_rate REAL,
                leverage REAL,
                take_profit_rate REAL,
                stop_loss_rate REAL,
                opened_at TEXT,
                closed_at TEXT,
                updated_at TEXT NOT NULL,
                raw_json TEXT,
                UNIQUE (session_id, broker, broker_position_id),
                FOREIGN KEY (session_id) REFERENCES trading_sessions(id)
            );

            CREATE TABLE IF NOT EXISTS order_activity_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                broker TEXT NOT NULL,
                source TEXT,
                activity_type TEXT NOT NULL,
                broker_order_id TEXT,
                broker_position_id TEXT,
                status TEXT,
                instrument_token TEXT,
                symbol TEXT,
                occurred_at TEXT,
                received_at TEXT NOT NULL,
                raw_json TEXT,
                FOREIGN KEY (session_id) REFERENCES trading_sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_trading_sessions_started_at
                ON trading_sessions(started_at);
            CREATE INDEX IF NOT EXISTS idx_broker_orders_session
                ON broker_orders(session_id);
            CREATE INDEX IF NOT EXISTS idx_broker_positions_session
                ON broker_positions(session_id);
            CREATE INDEX IF NOT EXISTS idx_order_activity_session_time
                ON order_activity_events(session_id, received_at);
            CREATE INDEX IF NOT EXISTS idx_order_activity_order
                ON order_activity_events(broker_order_id);
            CREATE INDEX IF NOT EXISTS idx_order_activity_position
                ON order_activity_events(broker_position_id);
            """
        )
        conn.commit()
        conn.close()

    def create_session(
        self,
        broker: str,
        label: str | None = None,
        account_env: str | None = None,
        strategy_name: str | None = None,
        config: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> str:
        session_id = session_id or str(uuid.uuid4())
        started_at = _now_utc()
        label = label or f"{started_at} {broker}"

        conn = self._connect()
        conn.execute(
            """
            INSERT INTO trading_sessions (
                id, label, broker, account_env, strategy_name, started_at, config_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                label,
                broker,
                account_env,
                strategy_name,
                started_at,
                _json_dumps(config),
            ),
        )
        conn.commit()
        conn.close()
        return session_id

    def stop_session(self, session_id: str, summary: dict[str, Any] | None = None) -> None:
        conn = self._connect()
        conn.execute(
            """
            UPDATE trading_sessions
            SET status = 'stopped', stopped_at = ?, summary_json = ?
            WHERE id = ?
            """,
            (_now_utc(), _json_dumps(summary), session_id),
        )
        conn.commit()
        conn.close()

    def record_activity(self, session_id: str, broker: str, activity: OrderActivity) -> None:
        raw = activity.raw or {}
        event_payload = _activity_payload(activity)
        event_data = _event_data(activity)
        received_at = _now_utc()
        occurred_at = _first_value(
            event_data,
            "occurred",
            "Occurred",
            "requestOccurred",
            "RequestOccurred",
            "openDateTime",
            "OpenDateTime",
            "lastUpdate",
            "LastUpdate",
        )
        symbol = _first_value(event_data, "symbol", "Symbol", "symbolFull", "instrumentDisplayName")
        instrument_token = activity.instrument_id or _first_value(
            event_data,
            "instrumentID",
            "instrumentId",
            "InstrumentID",
        )

        conn = self._connect()
        conn.execute(
            """
            INSERT INTO order_activity_events (
                session_id, broker, source, activity_type, broker_order_id,
                broker_position_id, status, instrument_token, symbol,
                occurred_at, received_at, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                broker,
                activity.source,
                activity.activity_type,
                activity.order_id,
                activity.position_id,
                activity.status,
                instrument_token,
                symbol,
                occurred_at,
                received_at,
                _json_dumps(event_payload),
            ),
        )

        if activity.order_id and activity.activity_type != "position_snapshot":
            self._upsert_order(conn, session_id, broker, activity, event_data, received_at)

        if activity.position_id:
            self._upsert_position(conn, session_id, broker, activity, event_data, received_at)

        # Some order-status payloads contain the positions opened by that order.
        for position in event_data.get("positions", []) or []:
            self._upsert_position_from_raw(conn, session_id, broker, activity.order_id, position, received_at)

        conn.commit()
        conn.close()

    def list_sessions(self, limit: int = 100) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM trading_sessions ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        return [_row_to_dict(row) for row in rows]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM trading_sessions WHERE id = ?", (session_id,)).fetchone()
        conn.close()
        return _row_to_dict(row) if row else None

    def get_orders(self, session_id: str) -> list[dict[str, Any]]:
        return self._query_by_session("broker_orders", session_id)

    def get_positions(self, session_id: str) -> list[dict[str, Any]]:
        return self._query_by_session("broker_positions", session_id)

    def get_activity_history(self, session_id: str, limit: int = 500) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM order_activity_events
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
        conn.close()
        return [_row_to_dict(row) for row in rows]

    def get_position_ids_for_order(self, session_id: str, broker_order_id: str | int) -> list[str]:
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT broker_position_id FROM broker_positions
            WHERE session_id = ? AND opening_broker_order_id = ?
            ORDER BY id
            """,
            (session_id, str(broker_order_id)),
        ).fetchall()
        conn.close()
        return [row["broker_position_id"] for row in rows]

    def _query_by_session(self, table: str, session_id: str) -> list[dict[str, Any]]:
        conn = self._connect()
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
        conn.close()
        return [_row_to_dict(row) for row in rows]

    def _upsert_order(
        self,
        conn,
        session_id: str,
        broker: str,
        activity: OrderActivity,
        data: dict[str, Any],
        updated_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO broker_orders (
                session_id, broker, broker_order_id, broker_unique_order_id,
                broker_position_id, instrument_token, symbol, exchange, side,
                intent, order_type, status, quantity, amount, price,
                take_profit_rate, stop_loss_rate, placed_at, updated_at, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, broker, broker_order_id) DO UPDATE SET
                broker_unique_order_id = COALESCE(excluded.broker_unique_order_id, broker_orders.broker_unique_order_id),
                broker_position_id = COALESCE(excluded.broker_position_id, broker_orders.broker_position_id),
                instrument_token = COALESCE(excluded.instrument_token, broker_orders.instrument_token),
                symbol = COALESCE(excluded.symbol, broker_orders.symbol),
                exchange = COALESCE(excluded.exchange, broker_orders.exchange),
                side = COALESCE(excluded.side, broker_orders.side),
                intent = COALESCE(excluded.intent, broker_orders.intent),
                order_type = COALESCE(excluded.order_type, broker_orders.order_type),
                status = COALESCE(excluded.status, broker_orders.status),
                quantity = COALESCE(excluded.quantity, broker_orders.quantity),
                amount = COALESCE(excluded.amount, broker_orders.amount),
                price = COALESCE(excluded.price, broker_orders.price),
                take_profit_rate = COALESCE(excluded.take_profit_rate, broker_orders.take_profit_rate),
                stop_loss_rate = COALESCE(excluded.stop_loss_rate, broker_orders.stop_loss_rate),
                placed_at = COALESCE(broker_orders.placed_at, excluded.placed_at),
                updated_at = excluded.updated_at,
                raw_json = excluded.raw_json
            """,
            (
                session_id,
                broker,
                activity.order_id,
                _first_value(data, "token", "requestToken", "RequestToken"),
                activity.position_id,
                activity.instrument_id or _first_value(data, "instrumentID", "instrumentId", "InstrumentID"),
                _first_value(data, "symbol", "Symbol", "symbolFull"),
                _first_value(data, "exchange", "Exchange"),
                _side(data),
                _intent(activity.activity_type),
                _order_type(activity.activity_type, data),
                activity.status or _first_value(data, "statusID", "statusId", "StatusID", "StatusId"),
                _number_value(data, "units", "amountInUnits", "AmountInUnits", "RequestedUnits"),
                _number_value(data, "amount", "Amount"),
                _number_value(data, "rate", "openRate", "EndRate"),
                _number_value(data, "takeProfitRate", "TakeProfitRate"),
                _number_value(data, "stopLossRate", "StopLossRate"),
                _first_value(data, "openDateTime", "OpenDateTime", "requestOccurred", "RequestOccurred"),
                updated_at,
                _json_dumps(_activity_payload(activity)),
            ),
        )

    def _upsert_position(
        self,
        conn,
        session_id: str,
        broker: str,
        activity: OrderActivity,
        data: dict[str, Any],
        updated_at: str,
    ) -> None:
        self._upsert_position_from_raw(conn, session_id, broker, activity.order_id, data, updated_at, activity)

    def _upsert_position_from_raw(
        self,
        conn,
        session_id: str,
        broker: str,
        order_id: str | None,
        position: dict[str, Any],
        updated_at: str,
        activity: OrderActivity | None = None,
    ) -> None:
        position_id = (activity.position_id if activity else None) or _first_value(
            position,
            "positionID",
            "positionId",
            "PositionID",
        )
        if not position_id:
            return

        conn.execute(
            """
            INSERT INTO broker_positions (
                session_id, broker, broker_position_id, opening_broker_order_id,
                instrument_token, symbol, exchange, side, status, units,
                invested_amount, open_rate, leverage, take_profit_rate,
                stop_loss_rate, opened_at, closed_at, updated_at, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, broker, broker_position_id) DO UPDATE SET
                opening_broker_order_id = COALESCE(excluded.opening_broker_order_id, broker_positions.opening_broker_order_id),
                instrument_token = COALESCE(excluded.instrument_token, broker_positions.instrument_token),
                symbol = COALESCE(excluded.symbol, broker_positions.symbol),
                exchange = COALESCE(excluded.exchange, broker_positions.exchange),
                side = COALESCE(excluded.side, broker_positions.side),
                status = COALESCE(excluded.status, broker_positions.status),
                units = COALESCE(excluded.units, broker_positions.units),
                invested_amount = COALESCE(excluded.invested_amount, broker_positions.invested_amount),
                open_rate = COALESCE(excluded.open_rate, broker_positions.open_rate),
                leverage = COALESCE(excluded.leverage, broker_positions.leverage),
                take_profit_rate = COALESCE(excluded.take_profit_rate, broker_positions.take_profit_rate),
                stop_loss_rate = COALESCE(excluded.stop_loss_rate, broker_positions.stop_loss_rate),
                opened_at = COALESCE(broker_positions.opened_at, excluded.opened_at),
                closed_at = COALESCE(excluded.closed_at, broker_positions.closed_at),
                updated_at = excluded.updated_at,
                raw_json = excluded.raw_json
            """,
            (
                session_id,
                broker,
                position_id,
                order_id or _first_value(position, "orderID", "orderId", "OrderID"),
                (activity.instrument_id if activity else None)
                or _first_value(position, "instrumentID", "instrumentId", "InstrumentID"),
                _first_value(position, "symbol", "Symbol", "symbolFull"),
                _first_value(position, "exchange", "Exchange"),
                _side(position),
                (activity.status if activity else None)
                or _first_value(position, "statusID", "statusId", "redeemStatusId", "StatusID", "StatusId"),
                _number_value(position, "units", "ExecutedUnits", "RequestedUnits"),
                _number_value(position, "amount", "initialAmountInDollars"),
                _number_value(position, "openRate", "rate", "EndRate"),
                _number_value(position, "leverage"),
                _number_value(position, "takeProfitRate", "TakeProfitRate"),
                _number_value(position, "stopLossRate", "StopLossRate"),
                _first_value(position, "openDateTime", "OpenDateTime", "occurred"),
                _first_value(position, "closeDateTime", "CloseDateTime"),
                updated_at,
                _json_dumps(position),
            ),
        )


class DbOrderActivityListener:
    """OrderActivityListener that persists live updates for replay and recovery."""

    def __init__(self, store: OrderActivityStore, session_id: str, broker: str):
        self.store = store
        self.session_id = session_id
        self.broker = broker

    def enqueue_order_activity(self, activity: OrderActivity) -> None:
        self.store.record_activity(self.session_id, self.broker, activity)
        logger.info(
            "[OrderActivityDB] persisted %s order=%s position=%s",
            activity.activity_type,
            activity.order_id,
            activity.position_id,
        )

    async def handle_order_activity(self, activity: OrderActivity) -> None:
        self.enqueue_order_activity(activity)


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _activity_payload(activity: OrderActivity) -> dict[str, Any]:
    payload = asdict(activity)
    payload["raw"] = activity.raw or {}
    return payload


def _event_data(activity: OrderActivity) -> dict[str, Any]:
    raw = activity.raw or {}
    if isinstance(raw.get("content"), dict):
        return raw["content"]
    return raw


def _json_dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, default=str)


def _row_to_dict(row) -> dict[str, Any]:
    result = dict(row)
    for key in ("config_json", "summary_json", "raw_json"):
        if result.get(key):
            try:
                result[key] = json.loads(result[key])
            except json.JSONDecodeError:
                pass
    return result


def _first_value(data: dict[str, Any], *keys: str) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in keys:
        value = data.get(key)
        if value is not None:
            return str(value)
    return None


def _number_value(data: dict[str, Any], *keys: str) -> float | None:
    value = _first_value(data, *keys)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _side(data: dict[str, Any]) -> str | None:
    value = data.get("isBuy")
    if value is None:
        value = data.get("IsBuy")
    if value is None:
        return None
    return "BUY" if bool(value) else "SELL"


def _intent(activity_type: str) -> str | None:
    if "close" in activity_type.lower():
        return "CLOSE"
    if "open" in activity_type.lower() or "position" in activity_type.lower():
        return "OPEN"
    return None


def _order_type(activity_type: str, data: dict[str, Any]) -> str | None:
    if "limit" in activity_type.lower():
        return "LIMIT"
    if "market" in activity_type.lower() or "open_order" in activity_type.lower() or "close_order" in activity_type.lower():
        return "MARKET"
    raw_type = _first_value(data, "orderType", "OrderType")
    return raw_type
