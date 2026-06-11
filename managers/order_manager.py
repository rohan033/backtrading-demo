import asyncio
from typing import Any

from logzero import logger

from brokers.interfaces import OrderActivity, OrderActivityListener, TickData
from managers.bgp_log import bgp_info, summarize_etoro_position


class OrderManager:
    """Dispatch order and position activity from a status client to listeners."""

    def __init__(self, client=None, max_activity_history: int = 1000):
        self.client = client
        self.max_activity_history = max_activity_history
        self._listeners: dict[str, OrderActivityListener] = {}
        self._orders_by_id: dict[str, dict[str, Any]] = {}
        self._positions_by_id: dict[str, dict[str, Any]] = {}
        self._order_to_position_ids: dict[str, set[str]] = {}
        self._protected_entries: dict[str, dict[str, Any]] = {}
        self._activity_history: list[OrderActivity] = []
        self._last_status: dict[str, Any] | None = None
        self._tick_queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=1000)
        self._tick_task: asyncio.Task | None = None
        self._running = False

        if client is not None and not hasattr(client, "add_status_callback"):
            raise TypeError("OrderManager client must expose add_status_callback(callback)")
        if client is not None:
            client.add_status_callback(self._handle_status)

    def register_listener(self, listener_id: str, listener: OrderActivityListener) -> None:
        self._listeners[listener_id] = listener

    def unregister_listener(self, listener_id: str) -> None:
        self._listeners.pop(listener_id, None)

    def track_order(self, order_id: str | int) -> None:
        if hasattr(self.client, "track_order"):
            self.client.track_order(order_id)

    def untrack_order(self, order_id: str | int) -> None:
        if hasattr(self.client, "untrack_order"):
            self.client.untrack_order(order_id)

    def get_order(self, order_id: str | int) -> dict[str, Any] | None:
        return self._orders_by_id.get(str(order_id))

    def get_position(self, position_id: str | int) -> dict[str, Any] | None:
        return self._positions_by_id.get(str(position_id))

    def get_positions_for_order(self, order_id: str | int) -> list[dict[str, Any]]:
        position_ids = self._order_to_position_ids.get(str(order_id), set())
        return [
            position
            for position_id in position_ids
            if (position := self._positions_by_id.get(position_id)) is not None
        ]

    def get_position_ids_for_order(self, order_id: str | int) -> list[str]:
        return sorted(self._order_to_position_ids.get(str(order_id), set()))

    def get_open_positions(self) -> list[dict[str, Any]]:
        return list(self._positions_by_id.values())

    def get_orders(self) -> list[dict[str, Any]]:
        return list(self._orders_by_id.values())

    def get_activity_history(self) -> list[OrderActivity]:
        return list(self._activity_history)

    def register_protected_entry(
        self,
        *,
        executor_id: str,
        order_id: str | None,
        unique_order_id: str | None,
        signal,
        broker: str | None = None,
        native_bracket_order: bool = False,
    ) -> None:
        if native_bracket_order:
            logger.info("[OrderManager] Native bracket order active for %s; synthetic TP/SL disabled", executor_id)
            return

        self._protected_entries[executor_id] = {
            "executor_id": executor_id,
            "order_id": order_id,
            "unique_order_id": unique_order_id,
            "position_id": None,
            "broker": broker,
            "symbol": getattr(signal, "symbol", ""),
            "token": getattr(signal, "token", ""),
            "exchange": getattr(signal, "exchange", ""),
            "entry_price": getattr(signal, "entry_price", None),
            "take_profit_price": getattr(signal, "take_profit_price", None),
            "stop_loss_price": getattr(signal, "stop_loss_price", None),
            "quantity": getattr(signal, "quantity", None),
            "active": True,
        }
        logger.info("[OrderManager] Registered synthetic TP/SL guard for %s order=%s", executor_id, order_id)

    def set_protected_position_id(self, executor_id: str, position_id: str | None) -> None:
        entry = self._protected_entries.get(executor_id)
        if entry and position_id:
            entry["position_id"] = str(position_id)

    def rearm_protected_entry(self, executor_id: str) -> None:
        entry = self._protected_entries.get(executor_id)
        if entry:
            entry["active"] = True

    def get_state_snapshot(self) -> dict[str, Any]:
        return {
            "orders_by_id": dict(self._orders_by_id),
            "positions_by_id": dict(self._positions_by_id),
            "order_to_position_ids": {
                order_id: sorted(position_ids)
                for order_id, position_ids in self._order_to_position_ids.items()
            },
            "protected_entries": dict(self._protected_entries),
            "last_status": self._last_status,
        }

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._tick_task = asyncio.create_task(self._tick_loop())
        if self.client is not None:
            await self.client.start()
        logger.info("[OrderManager] Started with %d listeners", len(self._listeners))

    async def stop(self) -> None:
        self._running = False
        if self._tick_task:
            self._tick_task.cancel()
            try:
                await self._tick_task
            except asyncio.CancelledError:
                pass
            self._tick_task = None
        if self.client is not None:
            await self.client.stop()
        logger.info("[OrderManager] Stopped")

    def enqueue_tick(self, tick: TickData) -> None:
        if not self._running:
            return
        try:
            self._tick_queue.put_nowait(tick)
        except asyncio.QueueFull:
            logger.warning("[OrderManager] Tick queue full; dropping TP/SL tick for %s", tick.symbol)

    async def _tick_loop(self) -> None:
        while True:
            tick = await self._tick_queue.get()
            await self.handle_tick(tick)

    async def handle_tick(self, tick: TickData) -> None:
        for executor_id, entry in list(self._protected_entries.items()):
            if not entry.get("active"):
                continue
            if str(entry.get("token")) != str(tick.token):
                continue

            trigger_type = None
            take_profit = _to_float(entry.get("take_profit_price"))
            stop_loss = _to_float(entry.get("stop_loss_price"))
            if take_profit is not None and tick.ltp >= take_profit:
                trigger_type = "take_profit_triggered"
            elif stop_loss is not None and tick.ltp <= stop_loss:
                trigger_type = "stop_loss_triggered"

            if not trigger_type:
                continue

            entry["active"] = False
            activity = OrderActivity(
                activity_type=trigger_type,
                order_id=entry.get("order_id"),
                position_id=entry.get("position_id"),
                status="triggered",
                instrument_id=str(tick.token),
                source="feed",
                raw={
                    **entry,
                    "executor_id": executor_id,
                    "trigger_type": trigger_type,
                    "ltp": tick.ltp,
                    "symbol": tick.symbol,
                    "token": tick.token,
                    "exchange": tick.exchange,
                },
            )
            self._apply_activity(activity)
            await self._dispatch(activity)

    async def _handle_status(self, status: dict[str, Any]) -> None:
        self._last_status = status
        activities = self._activities_from_status(status)
        if status.get("type") == "portfolio_status_snapshot":
            self._rebuild_snapshot_state(status)

        for activity in activities:
            if activity.source == "websocket" and activity.activity_type not in {
                "position_snapshot",
                "limit_order_snapshot",
                "open_order_snapshot",
                "close_order_snapshot",
            }:
                bgp_info(
                    "order_manager",
                    "websocket_activity",
                    activity_type=activity.activity_type,
                    order_id=activity.order_id,
                    position_id=activity.position_id,
                    status=activity.status,
                    instrument_id=activity.instrument_id,
                )
            self._apply_activity(activity)
            await self._dispatch(activity)

    async def _dispatch(self, activity: OrderActivity) -> None:
        for listener_id, listener in list(self._listeners.items()):
            try:
                listener.enqueue_order_activity(activity)
            except AttributeError:
                await listener.handle_order_activity(activity)
            except Exception as e:
                logger.error("[OrderManager] Listener %s notification failed: %s", listener_id, e)

    def _apply_activity(self, activity: OrderActivity) -> None:
        self._activity_history.append(activity)
        if len(self._activity_history) > self.max_activity_history:
            self._activity_history = self._activity_history[-self.max_activity_history:]

        raw = activity.raw or {}
        if activity.order_id and activity.activity_type != "position_snapshot":
            self._orders_by_id[activity.order_id] = {
                **self._orders_by_id.get(activity.order_id, {}),
                "order_id": activity.order_id,
                "position_id": activity.position_id,
                "status": activity.status,
                "instrument_id": activity.instrument_id,
                "activity_type": activity.activity_type,
                "source": activity.source,
                "raw": raw,
            }

        if activity.position_id:
            self._positions_by_id[activity.position_id] = {
                **self._positions_by_id.get(activity.position_id, {}),
                "position_id": activity.position_id,
                "order_id": activity.order_id,
                "status": activity.status,
                "instrument_id": activity.instrument_id,
                "activity_type": activity.activity_type,
                "source": activity.source,
                "raw": raw,
            }

        if activity.order_id and activity.position_id:
            self._order_to_position_ids.setdefault(activity.order_id, set()).add(activity.position_id)

        if activity.order_id and activity.position_id:
            for entry in self._protected_entries.values():
                if str(entry.get("order_id")) == str(activity.order_id):
                    entry["position_id"] = activity.position_id

    def _rebuild_snapshot_state(self, snapshot: dict[str, Any]) -> None:
        previous_position_summaries = {
            position_id: summarize_etoro_position(position.get("raw") or position)
            for position_id, position in self._positions_by_id.items()
        }

        orders_by_id: dict[str, dict[str, Any]] = {}
        positions_by_id: dict[str, dict[str, Any]] = {}
        order_to_position_ids: dict[str, set[str]] = {}

        for key, activity_type in (
            ("orders", "limit_order_snapshot"),
            ("orders_for_open", "open_order_snapshot"),
            ("orders_for_close", "close_order_snapshot"),
        ):
            for order in snapshot.get(key, []) or []:
                order_id = self._first_value(order, "orderID", "orderId")
                if not order_id:
                    continue

                orders_by_id[order_id] = {
                    "order_id": order_id,
                    "position_id": self._first_value(order, "positionID", "positionId"),
                    "status": self._first_value(order, "statusID", "statusId"),
                    "instrument_id": self._first_value(order, "instrumentID", "instrumentId"),
                    "activity_type": activity_type,
                    "source": "polling",
                    "raw": order,
                }

        for position in snapshot.get("positions", []) or []:
            position_id = self._first_value(position, "positionID", "positionId")
            order_id = self._first_value(position, "orderID", "orderId")
            if not position_id:
                continue

            positions_by_id[position_id] = {
                "position_id": position_id,
                "order_id": order_id,
                "status": self._first_value(position, "statusID", "statusId", "redeemStatusId"),
                "instrument_id": self._first_value(position, "instrumentID", "instrumentId"),
                "activity_type": "position_snapshot",
                "source": "polling",
                "raw": position,
            }
            if order_id:
                order_to_position_ids.setdefault(order_id, set()).add(position_id)

        for order_id, order_status in (snapshot.get("tracked_order_statuses") or {}).items():
            orders_by_id[str(order_id)] = {
                **orders_by_id.get(str(order_id), {}),
                "order_id": str(order_id),
                "status": self._first_value(order_status, "statusID", "statusId"),
                "instrument_id": self._first_value(order_status, "instrumentID", "instrumentId"),
                "activity_type": "tracked_order_status",
                "source": "polling",
                "raw": order_status,
            }

            for position in order_status.get("positions", []) or []:
                position_id = self._first_value(position, "positionID", "positionId")
                if not position_id:
                    continue

                positions_by_id.setdefault(
                    position_id,
                    {
                        "position_id": position_id,
                        "order_id": str(order_id),
                        "status": self._first_value(position, "statusID", "statusId"),
                        "instrument_id": self._first_value(position, "instrumentID", "instrumentId"),
                        "activity_type": "tracked_order_status",
                        "source": "polling",
                        "raw": position,
                    },
                )
                order_to_position_ids.setdefault(str(order_id), set()).add(position_id)

        current_position_summaries = {
            position_id: summarize_etoro_position(position.get("raw") or position)
            for position_id, position in positions_by_id.items()
        }
        for position_id, current in current_position_summaries.items():
            previous = previous_position_summaries.get(position_id)
            if previous is None:
                bgp_info(
                    "order_manager",
                    "POSITION_ADDED",
                    position_id=position_id,
                    current=current,
                )
            elif previous != current:
                bgp_info(
                    "order_manager",
                    "POSITION_UPDATED",
                    position_id=position_id,
                    previous=previous,
                    current=current,
                )
        for position_id, previous in previous_position_summaries.items():
            if position_id not in current_position_summaries:
                bgp_info(
                    "order_manager",
                    "POSITION_REMOVED",
                    position_id=position_id,
                    previous=previous,
                )

        self._orders_by_id = orders_by_id
        self._positions_by_id = positions_by_id
        for order_id, position_ids in order_to_position_ids.items():
            self._order_to_position_ids.setdefault(order_id, set()).update(position_ids)

    def _activities_from_status(self, status: dict[str, Any]) -> list[OrderActivity]:
        status_type = status.get("type")
        if status_type == "portfolio_status_snapshot":
            return self._activities_from_snapshot(status)
        if status_type == "portfolio_status_update":
            return [self._activity_from_websocket_update(status)]
        if status_type == "angel_order_status_update":
            return [self._activity_from_angel_order_update(status)]
        if status_type == "websocket_error":
            return [
                OrderActivity(
                    activity_type="websocket_error",
                    source="websocket",
                    raw=status.get("raw") or status,
                )
            ]
        return [
            OrderActivity(
                activity_type=str(status_type or "unknown_status"),
                raw=status,
            )
        ]

    def _activities_from_snapshot(self, snapshot: dict[str, Any]) -> list[OrderActivity]:
        activities: list[OrderActivity] = []

        for position in snapshot.get("positions", []) or []:
            activities.append(
                OrderActivity(
                    activity_type="position_snapshot",
                    order_id=self._first_value(position, "orderID", "orderId"),
                    position_id=self._first_value(position, "positionID", "positionId"),
                    status=self._first_value(position, "statusID", "statusId", "redeemStatusId"),
                    instrument_id=self._first_value(position, "instrumentID", "instrumentId"),
                    source="polling",
                    raw=position,
                )
            )

        for key, activity_type in (
            ("orders", "limit_order_snapshot"),
            ("orders_for_open", "open_order_snapshot"),
            ("orders_for_close", "close_order_snapshot"),
        ):
            for order in snapshot.get(key, []) or []:
                activities.append(
                    OrderActivity(
                        activity_type=activity_type,
                        order_id=self._first_value(order, "orderID", "orderId"),
                        position_id=self._first_value(order, "positionID", "positionId"),
                        status=self._first_value(order, "statusID", "statusId"),
                        instrument_id=self._first_value(order, "instrumentID", "instrumentId"),
                        source="polling",
                        raw=order,
                    )
                )

        for order_id, order_status in (snapshot.get("tracked_order_statuses") or {}).items():
            activities.append(
                OrderActivity(
                    activity_type="tracked_order_status",
                    order_id=str(order_id),
                    status=self._first_value(order_status, "statusID", "statusId"),
                    instrument_id=self._first_value(order_status, "instrumentID", "instrumentId"),
                    source="polling",
                    raw=order_status,
                )
            )

        return activities

    def _activity_from_angel_order_update(self, update: dict[str, Any]) -> OrderActivity:
        content = update.get("content") if isinstance(update.get("content"), dict) else {}
        return OrderActivity(
            activity_type=str(update.get("event_type") or "angel_order_status_update"),
            order_id=update.get("order_id") or content.get("orderid") or content.get("orderId"),
            status=update.get("status") or content.get("orderstatus") or content.get("status"),
            instrument_id=content.get("symboltoken") or content.get("symbolToken"),
            source="websocket",
            raw=update,
        )

    def _activity_from_websocket_update(self, update: dict[str, Any]) -> OrderActivity:
        content = update.get("content") or {}
        pending_position_ids = content.get("PendingClosePositionIDs") or content.get("pendingClosePositionIDs") or []
        position_id = (
            self._first_value(content, "positionID", "positionId", "PositionID")
            or (str(pending_position_ids[0]) if pending_position_ids else None)
        )

        return OrderActivity(
            activity_type=str(update.get("event_type") or "portfolio_status_update"),
            order_id=self._first_value(content, "OrderID", "orderID", "orderId"),
            position_id=position_id,
            status=self._first_value(content, "StatusID", "StatusId", "statusID", "statusId"),
            instrument_id=self._first_value(content, "InstrumentID", "instrumentID", "instrumentId"),
            source="websocket",
            raw=update,
        )

    @staticmethod
    def _first_value(data: dict[str, Any], *keys: str) -> str | None:
        if not isinstance(data, dict):
            return None

        for key in keys:
            value = data.get(key)
            if value is not None:
                return str(value)
        return None


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
