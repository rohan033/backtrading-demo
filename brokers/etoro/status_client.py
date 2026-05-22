import asyncio
import json
import uuid
from typing import Awaitable, Callable, Any

from logzero import logger

from brokers.etoro.trading_client import EtoroTradingClient


StatusCallback = Callable[[dict[str, Any]], None | Awaitable[None]]


class EtoroPortfolioStatusClient(EtoroTradingClient):
    """Polling client for eToro positions and tracked order statuses."""

    def __init__(self, interval_seconds: float = 2.0):
        super().__init__()
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
    ):
        super().__init__()
        self.websocket_url = websocket_url
        self.snapshot = snapshot
        self.max_update_history = max_update_history
        self._callbacks: list[StatusCallback] = []
        self.latest_update: dict[str, Any] | None = None
        self.update_history: list[dict[str, Any]] = []
        self._running = False
        self._task: asyncio.Task | None = None
        self._socket = None

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
                async with websockets.connect(self.websocket_url) as socket:
                    self._socket = socket
                    await self._authenticate()
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

    async def _authenticate(self) -> None:
        await self._send(
            {
                "operation": "Authenticate",
                "data": {
                    "userKey": self.user_key,
                    "apiKey": self.api_key,
                },
            }
        )

    async def _subscribe_private(self) -> None:
        await self._send(
            {
                "operation": "Subscribe",
                "data": {
                    "topics": ["private"],
                    "snapshot": self.snapshot,
                },
            }
        )

    async def _send(self, message: dict[str, Any]) -> None:
        if not self._socket:
            return

        payload = {"id": str(uuid.uuid4()), **message}
        await self._socket.send(json.dumps(payload))

    async def _handle_message(self, raw_message: str) -> None:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("[eToro] Ignoring non-JSON portfolio websocket message: %s", raw_message)
            return

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
