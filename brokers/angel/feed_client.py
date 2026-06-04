from __future__ import annotations

import asyncio
import threading
import uuid
from collections import defaultdict
from typing import Awaitable, Callable

from logzero import logger
from SmartApi.smartWebSocketV2 import SmartWebSocketV2

from brokers.angel.client import AngelClient
from brokers.angel.exchange_types import exchange_type_for_code, paise_to_rupees
from brokers.interfaces import Subscription, TickData

TickCallback = Callable[[TickData], None | Awaitable[None]]


class _AngelStreamBridge(SmartWebSocketV2):
    def __init__(self, *, loop: asyncio.AbstractEventLoop, event_queue: asyncio.Queue, **kwargs):
        super().__init__(**kwargs)
        self._loop = loop
        self._event_queue = event_queue
        self._pending_subscribe: tuple[str, int, list[dict]] | None = None

    def _emit(self, kind: str, payload) -> None:
        self._loop.call_soon_threadsafe(self._event_queue.put_nowait, (kind, payload))

    def on_open(self, wsapp):
        self._emit("open", None)
        if self._pending_subscribe is not None:
            correlation_id, mode, token_list = self._pending_subscribe
            try:
                SmartWebSocketV2.subscribe(self, correlation_id, mode, token_list)
            except Exception as exc:
                logger.error("[Angel] Subscribe failed on open: %s", exc)
                self._emit("error", str(exc))

    def on_data(self, wsapp, data):
        self._emit("tick", data)

    def on_close(self, wsapp):
        self._emit("close", None)

    def on_error(self, *args):
        message = args[-1] if args else "unknown websocket error"
        self._emit("error", str(message))

    def _on_message(self, wsapp, message):
        if message in ("pong", "ping"):
            if message == "pong":
                self._on_pong(wsapp, message)
            else:
                self._on_ping(wsapp, message)
            return

        if isinstance(message, (bytes, bytearray)):
            try:
                parsed_message = self._parse_binary_data(message)
                if self._is_control_message(parsed_message):
                    self._handle_control_message(parsed_message)
                else:
                    self.on_data(wsapp, parsed_message)
            except Exception as exc:
                logger.error("[Angel] Binary tick parse failed: %s", exc, exc_info=True)
                self._emit("error", str(exc))
            return

        if isinstance(message, str):
            logger.warning("[Angel] Smart stream text message: %s", message)
            self._emit("error", message)
            return

        logger.debug("[Angel] Ignoring websocket frame type=%s", type(message).__name__)

    def schedule_subscribe(self, correlation_id: str, mode: int, token_list: list[dict]) -> None:
        self._pending_subscribe = (correlation_id, mode, token_list)
        if self.wsapp is not None and getattr(self.wsapp, "sock", None):
            try:
                SmartWebSocketV2.subscribe(self, correlation_id, mode, token_list)
            except Exception as exc:
                logger.error("[Angel] Subscribe failed: %s", exc)
                self._emit("error", str(exc))


class AngelWebsocketFeedClient(AngelClient):
    """Angel SmartAPI WebSocket Streaming 2.0 feed."""

    def __init__(self, sample_every: int = 1):
        super().__init__()
        self.sample_every = max(1, int(sample_every))
        self._subscriptions: dict[str, Subscription] = {}
        self._callbacks: list[TickCallback] = []
        self._tick_counts: defaultdict[str, int] = defaultdict(int)
        self._running = False
        self._task: asyncio.Task | None = None
        self._thread: threading.Thread | None = None
        self._bridge: _AngelStreamBridge | None = None
        self._event_queue: asyncio.Queue | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connected = False
        self._pending_resync = False
        self._ready = asyncio.Event()
        self._start_error: str | None = None

    @classmethod
    def from_trading_client(cls, client: AngelClient, *, sample_every: int = 1) -> AngelWebsocketFeedClient:
        feed = cls(sample_every=sample_every)
        feed.api_key = client.api_key
        feed.userid = client.userid
        feed.mpin = client.mpin
        feed.totp_key = client.totp_key
        feed._client = client._client
        feed._auth_token = getattr(client, "_auth_token", None) or client._client.access_token
        feed._feed_token = getattr(client, "_feed_token", None) or client._client.feed_token
        return feed

    def subscribe(self, exchange: str, symbol: str, token: str) -> None:
        self._subscriptions[str(token)] = Subscription(exchange=exchange, symbol=symbol, token=str(token))

    def unsubscribe(self, token: str) -> None:
        self._subscriptions.pop(str(token), None)

    async def sync_subscriptions(self, subscriptions: list[Subscription]) -> None:
        self._subscriptions = {
            str(subscription.token): subscription
            for subscription in subscriptions
        }
        if self._connected and self._bridge is not None:
            self._apply_subscriptions()
        else:
            self._pending_resync = True

    def add_tick_callback(self, callback: TickCallback) -> None:
        self._callbacks.append(callback)

    async def start(self, *, wait_for_open: bool = True, open_timeout: float = 15.0) -> None:
        if self._running:
            return

        if not self.ensure_session_tokens():
            self.generate_session()

        if not self.ensure_session_tokens():
            raise RuntimeError("Angel websocket feed requires login tokens")
        if not self.userid or not self.api_key:
            raise RuntimeError("Angel websocket feed requires userid and api_key (ANGEL_* or legacy API_KEY/CLIENT_ID)")

        self._running = True
        self._ready = asyncio.Event()
        self._start_error = None
        self._loop = asyncio.get_running_loop()
        self._event_queue = asyncio.Queue()
        self._bridge = _AngelStreamBridge(
            loop=self._loop,
            event_queue=self._event_queue,
            auth_token=self._auth_token,
            api_key=self.api_key,
            client_code=self.userid,
            feed_token=self._feed_token,
            max_retry_attempt=3,
            retry_strategy=1,
            retry_delay=5,
        )
        self._thread = threading.Thread(
            target=self._bridge.connect,
            name="angel-smart-stream",
            daemon=True,
        )
        self._thread.start()
        self._task = asyncio.create_task(self._consume_events())
        logger.info("[Angel] Websocket feed started sample_every=%d", self.sample_every)

        if wait_for_open:
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=open_timeout)
            except asyncio.TimeoutError as exc:
                raise RuntimeError("Angel smart stream connection timed out") from exc
            if self._start_error:
                raise RuntimeError(self._start_error)

    async def stop(self) -> None:
        self._running = False
        if self._bridge is not None:
            self._bridge.close_connection()
            self._bridge = None
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        self._thread = None
        self._connected = False
        logger.info("[Angel] Websocket feed stopped")

    async def _consume_events(self) -> None:
        assert self._event_queue is not None

        while self._running:
            kind, payload = await self._event_queue.get()
            if kind == "open":
                self._connected = True
                logger.info("[Angel] Smart stream connected")
                if not self._ready.is_set():
                    self._ready.set()
                if self._subscriptions or self._pending_resync:
                    self._apply_subscriptions()
                    self._pending_resync = False
            elif kind == "tick":
                await self._handle_tick_payload(payload)
            elif kind == "close":
                self._connected = False
                logger.warning("[Angel] Smart stream closed")
            elif kind == "error":
                logger.error("[Angel] Smart stream error: %s", payload)
                if not self._ready.is_set():
                    self._start_error = str(payload)
                    self._ready.set()

    def _apply_subscriptions(self) -> None:
        if self._bridge is None or not self._subscriptions:
            return

        token_list_map: dict[int, list[str]] = defaultdict(list)
        for subscription in self._subscriptions.values():
            exchange_type = exchange_type_for_code(subscription.exchange)
            token_list_map[exchange_type].append(str(subscription.token))

        token_list = [
            {"exchangeType": exchange_type, "tokens": tokens}
            for exchange_type, tokens in token_list_map.items()
            if tokens
        ]
        if not token_list:
            return

        correlation_id = uuid.uuid4().hex[:10]
        self._bridge.schedule_subscribe(correlation_id, SmartWebSocketV2.LTP_MODE, token_list)
        logger.info("[Angel] Subscribed to %d token(s) over smart stream", len(self._subscriptions))

    async def _handle_tick_payload(self, payload: dict) -> None:
        token = str(payload.get("token") or "").strip()
        subscription = self._subscriptions.get(token)
        if not subscription:
            return

        if not self._should_forward(token):
            return

        ltp = paise_to_rupees(payload.get("last_traded_price"))
        if ltp is None or ltp <= 0:
            return

        await self._forward_tick(
            TickData(
                symbol=subscription.symbol,
                token=subscription.token,
                ltp=ltp,
                exchange=subscription.exchange,
            )
        )

    def _should_forward(self, token: str) -> bool:
        self._tick_counts[token] += 1
        return self._tick_counts[token] % self.sample_every == 0

    async def _forward_tick(self, tick: TickData) -> None:
        for callback in self._callbacks:
            try:
                result = callback(tick)
                if result is not None:
                    await result
            except Exception as exc:
                logger.error("[Angel] Tick callback error for %s: %s", tick.symbol, exc)
