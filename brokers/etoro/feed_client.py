import asyncio
import json
import uuid
from collections import defaultdict
from typing import Any, Awaitable, Callable

from logzero import logger

from brokers.etoro.env import ETORO_HTTP_USER_AGENT
from brokers.etoro.feed_config import normalize_feed_tick_sample_every
from brokers.etoro.trading_client import EtoroTradingClient
from brokers.interfaces import LTPData, Subscription, TickData


TickCallback = Callable[[TickData], None | Awaitable[None]]


class EtoroFeedClient(EtoroTradingClient):
    """Polling eToro feed that forwards latest trading prices at intervals."""

    def __init__(self, interval_seconds: float = 1.0):
        super().__init__()
        self.interval_seconds = interval_seconds
        self._subscriptions: dict[str, Subscription] = {}
        self._callbacks: list[TickCallback] = []
        self._running = False
        self._task: asyncio.Task | None = None

    def subscribe(self, exchange: str, symbol: str, token: str) -> None:
        self._subscriptions[token] = Subscription(exchange=exchange, symbol=symbol, token=token)

    def unsubscribe(self, token: str) -> None:
        self._subscriptions.pop(token, None)

    def add_tick_callback(self, callback: TickCallback) -> None:
        self._callbacks.append(callback)

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("[eToro] Polling feed started interval=%.2fs", self.interval_seconds)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[eToro] Polling feed stopped")

    async def _poll_loop(self) -> None:
        while self._running:
            try:
                await self.poll_once()
            except Exception as e:
                logger.error("[eToro] Polling feed error: %s", e)
            await asyncio.sleep(self.interval_seconds)

    async def poll_once(self) -> list[LTPData]:
        subscriptions = list(self._subscriptions.values())
        if not subscriptions:
            return []

        ltp_data = await self.aget_ltp_bulk(subscriptions)
        for item in ltp_data:
            await self._forward_tick(
                TickData(
                    symbol=item.symbol,
                    token=item.token,
                    ltp=item.ltp,
                    exchange=item.exchange,
                )
            )
        return ltp_data

    async def _forward_tick(self, tick: TickData) -> None:
        for callback in self._callbacks:
            try:
                result = callback(tick)
                if result is not None:
                    await result
            except Exception as e:
                logger.error("[eToro] Tick callback error for %s: %s", tick.symbol, e)


class EtoroWebsocketFeedClient(EtoroTradingClient):
    """eToro websocket feed with per-instrument tick sampling."""

    def __init__(
        self,
        sample_every: int = 0,
        websocket_url: str = "wss://ws.etoro.com/ws",
        snapshot: bool = False,
        account_env: str | None = None,
    ):
        super().__init__(account_env=account_env)
        self.sample_every = normalize_feed_tick_sample_every(sample_every)
        self.websocket_url = websocket_url
        self.snapshot = snapshot
        self._subscriptions: dict[int, Subscription] = {}
        self._callbacks: list[TickCallback] = []
        self._tick_counts: defaultdict[int, int] = defaultdict(int)
        self._running = False
        self._task: asyncio.Task | None = None
        self._socket = None
        self._authenticated = False
        self._pending_resync = False
        self._pending_operations: dict[str, tuple[str, asyncio.Future]] = {}

    async def subscribe(self, exchange: str, symbol: str, token: str) -> None:
        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            raise ValueError(f"Could not resolve eToro instrument for {symbol}/{token}")

        already_subscribed = instrument_id in self._subscriptions
        self._subscriptions[instrument_id] = Subscription(exchange=exchange, symbol=symbol, token=str(token))

        if already_subscribed:
            # Already tracked and (if connected) already subscribed on the WS — skip re-send
            return

        if self._socket and self._authenticated:
            await self._send_subscription("Subscribe", [instrument_id])
        elif self._socket:
            self._pending_resync = True

    async def unsubscribe(self, token: str) -> None:
        instrument_id = await self._instrument_id("", token)
        if instrument_id is None:
            return
        self._subscriptions.pop(instrument_id, None)

        if self._socket:
            await self._send_subscription("Unsubscribe", [instrument_id])

    def add_tick_callback(self, callback: TickCallback) -> None:
        self._callbacks.append(callback)

    async def sync_subscriptions(self, subscriptions: list[Subscription]) -> None:
        """Align websocket topics with the live engine's active tick listeners."""
        resolved: dict[int, Subscription] = {}
        for subscription in subscriptions:
            instrument_id = await self._instrument_id(subscription.symbol, subscription.token)
            if instrument_id is None:
                logger.warning(
                    "[eToro] Could not resolve instrument for feed sync %s/%s",
                    subscription.symbol,
                    subscription.token,
                )
                continue
            resolved[instrument_id] = Subscription(
                exchange=subscription.exchange,
                symbol=subscription.symbol,
                token=str(subscription.token),
            )

        previous_ids = set(self._subscriptions.keys())
        next_ids = set(resolved.keys())
        to_subscribe = sorted(next_ids - previous_ids)
        to_unsubscribe = sorted(previous_ids - next_ids)
        self._subscriptions = resolved

        if not self._socket:
            self._pending_resync = bool(resolved)
            logger.info(
                "[eToro] Deferred feed sync until websocket connects instruments=%d",
                len(resolved),
            )
            return
        if not self._authenticated:
            self._pending_resync = True
            logger.info(
                "[eToro] Deferred feed sync until websocket authenticated instruments=%d",
                len(resolved),
            )
            return
        if to_unsubscribe:
            await self._send_subscription("Unsubscribe", to_unsubscribe)
        if to_subscribe:
            logger.info(
                "[eToro] WS feed sync subscribe instruments=%s",
                to_subscribe,
            )
            await self._send_subscription("Subscribe", to_subscribe)

    async def start(self) -> None:
        if self._running:
            return

        self.generate_session()
        if not (self.api_key and self.user_key):
            raise ValueError("eToro websocket authentication requires ETORO_API_KEY and ETORO_USER_KEY")

        self._running = True
        self._task = asyncio.create_task(self._listen_loop())
        sample_label = "all" if self.sample_every == 0 else str(self.sample_every)
        logger.info("[eToro] Websocket feed started sample_every=%s", sample_label)

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
        logger.info("[eToro] Websocket feed stopped")

    async def _listen_loop(self) -> None:
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("Install the 'websockets' package to use EtoroWebsocketFeedClient") from exc

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
                    if self._subscriptions:
                        logger.info(
                            "[eToro] WS feed subscribing to %d instruments after auth: %s",
                            len(self._subscriptions),
                            sorted(self._subscriptions.keys()),
                        )
                        await self._send_subscription("Subscribe", list(self._subscriptions.keys()))
                    self._pending_resync = False

                    async for raw_message in socket:
                        await self._handle_message(raw_message)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._socket = None
                self._authenticated = False
                if self._running:
                    logger.error("[eToro] Websocket feed error: %s", e, exc_info=True)
                    await asyncio.sleep(3)

    async def _authenticate(self) -> dict[str, Any] | None:
        logger.info("[eToro] WS feed sending Authenticate")
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

    async def _send_subscription(self, operation: str, instrument_ids: list[int]) -> None:
        if not instrument_ids:
            return
        logger.info(
            "[eToro] WS feed sending %s topics=%s",
            operation,
            [f"instrument:{instrument_id}" for instrument_id in instrument_ids],
        )
        await self._send(
            {
                "operation": operation,
                "data": {
                    "topics": [f"instrument:{instrument_id}" for instrument_id in instrument_ids],
                    "snapshot": self.snapshot,
                },
            }
        )

    async def _send(self, message: dict) -> str | None:
        if not self._socket:
            return None

        payload = {"id": str(uuid.uuid4()), **message}
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
                "[eToro] WS feed %s response timed out after %.1fs (request_id=%s)",
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
                "[eToro] WS feed %s succeeded request_id=%s authenticated=%s",
                operation,
                request_id,
                self._authenticated,
            )
        else:
            error_code = message.get("errorCode") or ""
            log_fn = logger.debug if error_code == "TopicAlreadySubscribed" else logger.error
            log_fn(
                "[eToro] WS feed %s failed request_id=%s success=%s errorCode=%s errorMessage=%s",
                operation,
                request_id,
                success,
                error_code,
                message.get("errorMessage"),
            )
        return True

    async def _handle_message(self, raw_message: str | bytes) -> None:
        if isinstance(raw_message, (bytes, bytearray)):
            if raw_message in (b"\x00", b""):
                return
            logger.debug("[eToro] Ignoring non-text websocket frame: %r", raw_message)
            return

        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("[eToro] Ignoring non-JSON websocket message: %s", raw_message)
            return

        request_id = message.get("id")
        if request_id and request_id in self._pending_operations:
            operation_name, future = self._pending_operations[request_id]
            if not future.done():
                future.set_result(message)

        if self._log_control_response(message):
            if (
                message.get("success") is True
                and message.get("operation") == "Authenticate"
                and self._pending_resync
                and self._subscriptions
            ):
                await self._send_subscription("Subscribe", list(self._subscriptions.keys()))
                self._pending_resync = False
            return

        if "success" in message and message.get("success") is False:
            logger.error(
                "[eToro] WS feed error response: %s",
                json.dumps(message, default=str, sort_keys=True),
            )
            return

        for item in message.get("messages", []) or []:
            if item.get("type") != "Trading.Instrument.Rate":
                continue

            instrument_id = self._instrument_id_from_topic(item.get("topic"))
            subscription = self._subscriptions.get(instrument_id)
            if not subscription or not self._should_forward(instrument_id):
                continue

            content = item.get("content")
            if isinstance(content, str):
                content = json.loads(content)

            ltp = self._websocket_ltp(content)
            if ltp is None:
                continue

            await self._forward_tick(
                TickData(
                    symbol=subscription.symbol,
                    token=subscription.token,
                    ltp=ltp,
                    exchange=subscription.exchange,
                )
            )

    def _should_forward(self, instrument_id: int) -> bool:
        if self.sample_every == 0:
            return True
        self._tick_counts[instrument_id] += 1
        return self._tick_counts[instrument_id] % self.sample_every == 0

    async def _forward_tick(self, tick: TickData) -> None:
        for callback in self._callbacks:
            try:
                result = callback(tick)
                if result is not None:
                    await result
            except Exception as e:
                logger.error("[eToro] Websocket tick callback error for %s: %s", tick.symbol, e)

    @staticmethod
    def _instrument_id_from_topic(topic: str | None) -> int | None:
        if not topic or ":" not in topic:
            return None
        _, raw_id = topic.split(":", 1)
        try:
            return int(raw_id)
        except ValueError:
            return None

    @staticmethod
    def _websocket_ltp(rate: dict | None) -> float | None:
        if not isinstance(rate, dict):
            return None

        for key in ("LastExecution", "lastExecution"):
            value = rate.get(key)
            if value is not None:
                return float(value)

        bid = rate.get("Bid") or rate.get("bid")
        ask = rate.get("Ask") or rate.get("ask")
        if bid is not None and ask is not None:
            return (float(bid) + float(ask)) / 2
        if bid is not None:
            return float(bid)
        if ask is not None:
            return float(ask)
        return None
