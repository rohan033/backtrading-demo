from typing import Any

from logzero import logger

from brokers.interfaces import OrderActivity, OrderActivityListener


class OrderManager:
    """Dispatch order and position activity from a status client to listeners."""

    def __init__(self, client, max_activity_history: int = 1000):
        self.client = client
        self.max_activity_history = max_activity_history
        self._listeners: dict[str, OrderActivityListener] = {}
        self._orders_by_id: dict[str, dict[str, Any]] = {}
        self._positions_by_id: dict[str, dict[str, Any]] = {}
        self._order_to_position_ids: dict[str, set[str]] = {}
        self._activity_history: list[OrderActivity] = []
        self._last_status: dict[str, Any] | None = None
        self._running = False

        if not hasattr(client, "add_status_callback"):
            raise TypeError("OrderManager client must expose add_status_callback(callback)")
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

    def get_state_snapshot(self) -> dict[str, Any]:
        return {
            "orders_by_id": dict(self._orders_by_id),
            "positions_by_id": dict(self._positions_by_id),
            "order_to_position_ids": {
                order_id: sorted(position_ids)
                for order_id, position_ids in self._order_to_position_ids.items()
            },
            "last_status": self._last_status,
        }

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        await self.client.start()
        logger.info("[OrderManager] Started with %d listeners", len(self._listeners))

    async def stop(self) -> None:
        self._running = False
        await self.client.stop()
        logger.info("[OrderManager] Stopped")

    async def _handle_status(self, status: dict[str, Any]) -> None:
        self._last_status = status
        activities = self._activities_from_status(status)
        if status.get("type") == "portfolio_status_snapshot":
            self._rebuild_snapshot_state(status)

        for activity in activities:
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

    def _rebuild_snapshot_state(self, snapshot: dict[str, Any]) -> None:
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
