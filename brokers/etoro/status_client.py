import asyncio
import json
import uuid
from typing import Awaitable, Callable, Any

from logzero import logger

from brokers.etoro.env import ETORO_HTTP_USER_AGENT
from brokers.etoro.trading_client import EtoroTradingClient
from brokers.etoro.ws_order_events import (
    TERMINAL_ACTIONS,
    is_close_event,
    is_open_event,
    map_tracked_order_status,
)


def _is_order_websocket_event(event_type: str | None) -> bool:
    if not event_type:
        return False
    normalized = event_type.lower()
    if is_open_event(event_type) or is_close_event(event_type):
        return True
    return "order" in normalized


StatusCallback = Callable[[dict[str, Any]], None | Awaitable[None]]


class EtoroPortfolioStatusClient(EtoroTradingClient):
    """Polling client for eToro positions and tracked order statuses."""

    def __init__(self, interval_seconds: float = 2.0, account_env: str | None = None):
        super().__init__(account_env=account_env)
        self.interval_seconds = interval_seconds
        self._order_ids: set[str] = set()
        self._callbacks: list[StatusCallback] = []
        self.latest_snapshot: dict[str, Any] | None = None
        self.latest_positions: dict[str, dict[str, Any]] = {}
        self.latest_order_statuses: dict[str, dict[str, Any]] = {}
        self._running = False
        self._task: asyncio.Task | None = None

    def track_order(self, order_id: str | int) -> None:
        self._order_ids.add(str(order_id))

    def untrack_order(self, order_id: str | int) -> None:
        self._order_ids.discard(str(order_id))

    def add_status_callback(self, callback: StatusCallback) -> None:
        self._callbacks.append(callback)

    def get_latest_snapshot(self) -> dict[str, Any] | None:
        return self.latest_snapshot

    def get_latest_positions(self) -> list[dict[str, Any]]:
        return list(self.latest_positions.values())

    def get_latest_order_status(self, order_id: str | int) -> dict[str, Any] | None:
        return self.latest_order_statuses.get(str(order_id))

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("[eToro] Portfolio status polling started interval=%.2fs", self.interval_seconds)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[eToro] Portfolio status polling stopped")

    async def poll_once(self) -> dict[str, Any]:
        portfolio_response = await self.arequest("GET", f"{self.info_base_path()}/pnl")
        portfolio = portfolio_response.get("clientPortfolio", {}) if isinstance(portfolio_response, dict) else {}

        order_statuses = {}
        for order_id in list(self._order_ids):
            status = await self.aget_order_status(order_id)
            if status is not None:
                order_statuses[order_id] = status
                if map_tracked_order_status(status) in TERMINAL_ACTIONS:
                    self._order_ids.discard(str(order_id))

        snapshot = {
            "type": "portfolio_status_snapshot",
            "positions": portfolio.get("positions", []) or [],
            "orders": portfolio.get("orders", []) or [],
            "orders_for_open": portfolio.get("ordersForOpen", []) or [],
            "orders_for_close": portfolio.get("ordersForClose", []) or [],
            "tracked_order_statuses": order_statuses,
            "client_portfolio": portfolio,
        }
        self.latest_snapshot = snapshot
        self.latest_positions = {
            str(position_id): position
            for position in snapshot["positions"]
            if (position_id := position.get("positionID") or position.get("positionId")) is not None
        }
        self.latest_order_statuses = order_statuses
        await self._forward_status(snapshot)
        return snapshot

    async def _poll_loop(self) -> None:
        while self._running:
            try:
                await self.poll_once()
            except Exception as e:
                logger.error("[eToro] Portfolio status polling error: %s", e)
            await asyncio.sleep(self.interval_seconds)

    async def _forward_status(self, status: dict[str, Any]) -> None:
        for callback in self._callbacks:
            try:
                result = callback(status)
                if result is not None:
                    await result
            except Exception as e:
                logger.error("[eToro] Portfolio status callback error: %s", e)


class EtoroWebsocketPortfolioStatusClient(EtoroTradingClient):
    """Websocket client for private eToro order and position updates."""

    def __init__(
        self,
        websocket_url: str = "wss://ws.etoro.com/ws",
        snapshot: bool = True,
        max_update_history: int = 1000,
        account_env: str | None = None,
    ):
        super().__init__(account_env=account_env)
        self.websocket_url = websocket_url
        self.snapshot = snapshot
        self.max_update_history = max_update_history
        self._callbacks: list[StatusCallback] = []
        self.latest_update: dict[str, Any] | None = None
        self.update_history: list[dict[str, Any]] = []
        self._running = False
        self._task: asyncio.Task | None = None
        self._socket = None
        self._pending_operations: dict[str, tuple[str, asyncio.Future]] = {}
        self._authenticated = False

    def add_status_callback(self, callback: StatusCallback) -> None:
        self._callbacks.append(callback)

    def get_latest_update(self) -> dict[str, Any] | None:
        return self.latest_update

    def get_update_history(self) -> list[dict[str, Any]]:
        return list(self.update_history)

    async def start(self) -> None:
        if self._running:
            return

        self.generate_session()
        if not (self.api_key and self.user_key):
            raise ValueError("eToro websocket authentication requires ETORO_API_KEY and ETORO_USER_KEY")

        self._running = True
        self._task = asyncio.create_task(self._listen_loop())
        logger.info("[eToro] Portfolio websocket status client started")

    async def stop(self) -> None:
        self._running = False
        if self._socket:
            await self._socket.close()
            self._socket = None
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[eToro] Portfolio websocket status client stopped")

    async def _listen_loop(self) -> None:
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("Install the 'websockets' package to use EtoroWebsocketPortfolioStatusClient") from exc

        while self._running:
            try:
                async with websockets.connect(
                    self.websocket_url,
                    additional_headers=[("User-Agent", ETORO_HTTP_USER_AGENT)],
                ) as socket:
                    self._socket = socket
                    self._authenticated = False
                    auth_response = await self._authenticate()
                    if auth_response and auth_response.get("success") is False:
                        raise RuntimeError(
                            f"eToro websocket authentication failed: "
                            f"{auth_response.get('errorCode')} {auth_response.get('errorMessage')}"
                        )
                    await self._subscribe_private()

                    async for raw_message in socket:
                        await self._handle_message(raw_message)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._socket = None
                if self._running:
                    logger.error("[eToro] Portfolio websocket status error: %s", e)
                    await asyncio.sleep(3)

    async def _authenticate(self) -> dict[str, Any] | None:
        logger.info("[eToro] WS sending Authenticate")
        return await self._send_and_wait(
            {
                "operation": "Authenticate",
                "data": {
                    "userKey": self.user_key,
                    "apiKey": self.api_key,
                },
            },
            operation_name="Authenticate",
        )

    async def _subscribe_private(self) -> None:
        logger.info("[eToro] WS sending Subscribe topics=[private] snapshot=%s", self.snapshot)
        await self._send(
            {
                "operation": "Subscribe",
                "data": {
                    "topics": ["private"],
                    "snapshot": self.snapshot,
                },
            }
        )

    async def _send(self, message: dict[str, Any]) -> str | None:
        if not self._socket:
            return None

        payload = {"id": str(uuid.uuid4()), **message}
        operation = message.get("operation")
        if operation in {"Subscribe", "Unsubscribe"}:
            logger.info(
                "[eToro] WS sending %s request_id=%s data=%s",
                operation,
                payload["id"],
                message.get("data"),
            )
        await self._socket.send(json.dumps(payload))
        return payload["id"]

    async def _send_and_wait(
        self,
        message: dict[str, Any],
        *,
        operation_name: str,
        timeout: float = 10.0,
    ) -> dict[str, Any] | None:
        if not self._socket:
            return None

        payload = {"id": str(uuid.uuid4()), **message}
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending_operations[payload["id"]] = (operation_name, future)
        await self._socket.send(json.dumps(payload))
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "[eToro] WS %s response timed out after %.1fs (request_id=%s)",
                operation_name,
                timeout,
                payload["id"],
            )
            return None
        finally:
            self._pending_operations.pop(payload["id"], None)

    def _log_control_response(self, message: dict[str, Any]) -> bool:
        operation = message.get("operation")
        if operation not in {"Authenticate", "Subscribe", "Unsubscribe"}:
            return False

        request_id = message.get("id")
        success = message.get("success")
        if success is True:
            if operation == "Authenticate":
                self._authenticated = True
            logger.info(
                "[eToro] WS %s succeeded request_id=%s authenticated=%s",
                operation,
                request_id,
                self._authenticated,
            )
        else:
            logger.error(
                "[eToro] WS %s failed request_id=%s success=%s errorCode=%s errorMessage=%s",
                operation,
                request_id,
                success,
                message.get("errorCode"),
                message.get("errorMessage"),
            )
        return True

    async def _handle_message(self, raw_message: str | bytes) -> None:
        if isinstance(raw_message, (bytes, bytearray)):
            if raw_message in (b"\x00", b""):
                return
            logger.debug("[eToro] Ignoring non-text portfolio websocket frame: %r", raw_message)
            return

        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("[eToro] Ignoring non-JSON portfolio websocket message: %s", raw_message)
            return

        request_id = message.get("id")
        if request_id and request_id in self._pending_operations:
            operation_name, future = self._pending_operations[request_id]
            if not future.done():
                future.set_result(message)

        if self._log_control_response(message):
            if message.get("success") is False:
                await self._forward_status({"type": "websocket_error", "raw": message})
            return

        private_messages = [
            item for item in (message.get("messages", []) or []) if item.get("topic") == "private"
        ]
        if private_messages:
            logger.debug(
                "[eToro] WS private batch size=%d types=%s",
                len(private_messages),
                sorted({item.get("type") for item in private_messages if item.get("type")}),
            )

        if "success" in message and message.get("success") is False:
            await self._forward_status({"type": "websocket_error", "raw": message})
            return

        for item in message.get("messages", []) or []:
            if item.get("topic") != "private":
                continue

            content = item.get("content")
            if isinstance(content, str):
                content = json.loads(content)

            status_update = {
                "type": "portfolio_status_update",
                "event_type": item.get("type"),
                "message_id": item.get("id"),
                "content": content,
                "raw": item,
            }
            event_type = item.get("type") or ""
            if _is_order_websocket_event(event_type):
                logger.info(
                    "[eToro] Order status websocket JSON: %s",
                    json.dumps(item, default=str),
                )
            else:
                logger.debug("[eToro] WS private message type=%s", event_type)
            self.latest_update = status_update
            self.update_history.append(status_update)
            if len(self.update_history) > self.max_update_history:
                self.update_history = self.update_history[-self.max_update_history:]
            await self._forward_status(status_update)

    async def _forward_status(self, status: dict[str, Any]) -> None:
        for callback in self._callbacks:
            try:
                result = callback(status)
                if result is not None:
                    await result
            except Exception as e:
                logger.error("[eToro] Portfolio websocket status callback error: %s", e)


class EtoroHybridPortfolioStatusClient(EtoroTradingClient):
    """Websocket order updates with REST polling fallback for tracked orders."""

    def __init__(
        self,
        poll_interval_seconds: float = 3.0,
        websocket_url: str = "wss://ws.etoro.com/ws",
        snapshot: bool = True,
        account_env: str | None = None,
    ):
        super().__init__(account_env=account_env)
        self.poll_interval_seconds = poll_interval_seconds
        self._websocket = EtoroWebsocketPortfolioStatusClient(
            websocket_url=websocket_url,
            snapshot=snapshot,
            account_env=account_env,
        )
        self._order_ids: set[str] = set()
        self._callbacks: list[StatusCallback] = []
        self.latest_order_statuses: dict[str, dict[str, Any]] = {}
        self._running = False
        self._poll_task: asyncio.Task | None = None

    def track_order(self, order_id: str | int) -> None:
        self._order_ids.add(str(order_id))
        logger.info("[eToro] Tracking order for status polling: %s", order_id)
        if self._running:
            asyncio.create_task(self._poll_tracked_orders_once())

    def untrack_order(self, order_id: str | int) -> None:
        self._order_ids.discard(str(order_id))

    def add_status_callback(self, callback: StatusCallback) -> None:
        self._callbacks.append(callback)

    def get_latest_update(self) -> dict[str, Any] | None:
        return self._websocket.get_latest_update()

    async def start(self) -> None:
        if self._running:
            return

        self._websocket.add_status_callback(self._forward_status)
        self._running = True
        await self._websocket.start()
        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info(
            "[eToro] Hybrid portfolio status client started poll_interval=%.2fs",
            self.poll_interval_seconds,
        )

    async def stop(self) -> None:
        self._running = False
        await self._websocket.stop()
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        logger.info("[eToro] Hybrid portfolio status client stopped")

    async def _poll_loop(self) -> None:
        while self._running:
            try:
                await self._poll_tracked_orders_once()
            except Exception as e:
                logger.error("[eToro] Tracked-order polling error: %s", e)
            await asyncio.sleep(self.poll_interval_seconds)

    async def _poll_tracked_orders_once(self) -> None:
        if not self._order_ids:
            return

        order_statuses: dict[str, dict[str, Any]] = {}
        for order_id in list(self._order_ids):
            status = await self.aget_order_status(order_id)
            if status is None:
                continue

            order_statuses[str(order_id)] = status
            action = map_tracked_order_status(status)
            if action in TERMINAL_ACTIONS:
                logger.info(
                    "[eToro] Tracked order reached terminal state order=%s action=%s; untracking",
                    order_id,
                    action,
                )
                self._order_ids.discard(str(order_id))

        if not order_statuses:
            return

        self.latest_order_statuses.update(order_statuses)
        snapshot = {
            "type": "portfolio_status_snapshot",
            "positions": [],
            "orders": [],
            "orders_for_open": [],
            "orders_for_close": [],
            "tracked_order_statuses": order_statuses,
        }
        await self._forward_status(snapshot)

    async def _forward_status(self, status: dict[str, Any]) -> None:
        for callback in self._callbacks:
            try:
                result = callback(status)
                if result is not None:
                    await result
            except Exception as e:
                logger.error("[eToro] Hybrid portfolio status callback error: %s", e)
