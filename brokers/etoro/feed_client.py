import asyncio
from collections import defaultdict
from typing import Awaitable, Callable

from logzero import logger

from brokers.etoro.env import ETORO_HTTP_USER_AGENT
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
        sample_every: int = 1,
        websocket_url: str = "wss://ws.etoro.com/ws",
        snapshot: bool = False,
        account_env: str | None = None,
    ):
        super().__init__(account_env=account_env)
        self.sample_every = max(1, int(sample_every))
        self.websocket_url = websocket_url
        self.snapshot = snapshot
        self._subscriptions: dict[int, Subscription] = {}
        self._callbacks: list[TickCallback] = []
        self._tick_counts: defaultdict[int, int] = defaultdict(int)
        self._running = False
        self._task: asyncio.Task | None = None
        self._socket = None

    async def subscribe(self, exchange: str, symbol: str, token: str) -> None:
        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            raise ValueError(f"Could not resolve eToro instrument for {symbol}/{token}")
        self._subscriptions[instrument_id] = Subscription(exchange=exchange, symbol=symbol, token=str(token))

        if self._socket:
            await self._send_subscription("Subscribe", [instrument_id])

    async def unsubscribe(self, token: str) -> None:
        instrument_id = await self._instrument_id("", token)
        if instrument_id is None:
            return
        self._subscriptions.pop(instrument_id, None)

        if self._socket:
            await self._send_subscription("Unsubscribe", [instrument_id])

    def add_tick_callback(self, callback: TickCallback) -> None:
        self._callbacks.append(callback)

    async def start(self) -> None:
        if self._running:
            return

        self.generate_session()
        if not (self.api_key and self.user_key):
            raise ValueError("eToro websocket authentication requires ETORO_API_KEY and ETORO_USER_KEY")

        self._running = True
        self._task = asyncio.create_task(self._listen_loop())
        logger.info("[eToro] Websocket feed started sample_every=%d", self.sample_every)

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
                    await self._authenticate()
                    if self._subscriptions:
                        await self._send_subscription("Subscribe", list(self._subscriptions.keys()))

                    async for raw_message in socket:
                        await self._handle_message(raw_message)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._socket = None
                if self._running:
                    logger.error("[eToro] Websocket feed error: %s", e)
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

    async def _send_subscription(self, operation: str, instrument_ids: list[int]) -> None:
        await self._send(
            {
                "operation": operation,
                "data": {
                    "topics": [f"instrument:{instrument_id}" for instrument_id in instrument_ids],
                    "snapshot": self.snapshot,
                },
            }
        )

    async def _send(self, message: dict) -> None:
        import json
        import uuid

        if not self._socket:
            return

        payload = {"id": str(uuid.uuid4()), **message}
        await self._socket.send(json.dumps(payload))

    async def _handle_message(self, raw_message: str | bytes) -> None:
        import json

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
