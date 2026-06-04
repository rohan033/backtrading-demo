from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Awaitable, Callable

from logzero import logger
from SmartApi.smartWebSocketOrderUpdate import SmartWebSocketOrderUpdate

from brokers.angel.client import AngelClient, angel_bearer_token
from brokers.angel.ws_order_events import map_angel_order_status

StatusCallback = Callable[[dict[str, Any]], None | Awaitable[None]]


class _AngelOrderUpdateBridge(SmartWebSocketOrderUpdate):
    def __init__(self, *, loop: asyncio.AbstractEventLoop, event_queue: asyncio.Queue, **kwargs):
        super().__init__(**kwargs)
        self._loop = loop
        self._event_queue = event_queue
        self._auth_failed = False

    def connect(self):
        auth_token = angel_bearer_token(self.auth_token)
        if not all([auth_token, self.api_key, self.client_code, self.feed_token]):
            raise RuntimeError("Angel order status websocket missing auth headers")

        headers = {
            "Authorization": auth_token,
            "x-api-key": self.api_key,
            "x-client-code": self.client_code,
            "x-feed-token": self.feed_token,
        }
        try:
            import ssl
            import websocket

            self.wsapp = websocket.WebSocketApp(
                self.WEBSOCKET_URI,
                header=headers,
                on_open=self.on_open,
                on_error=self.on_error,
                on_close=self.on_close,
                on_data=self.on_data,
                on_ping=self.on_ping,
                on_pong=self.on_pong,
            )
            self.wsapp.run_forever(
                sslopt={"cert_reqs": ssl.CERT_NONE},
                ping_interval=self.HEARTBEAT_INTERVAL_SECONDS,
            )
        except Exception as exc:
            self._loop.call_soon_threadsafe(self._event_queue.put_nowait, ("error", str(exc)))

    def retry_connect(self):
        if self._auth_failed:
            logger.warning("[Angel] Order status websocket auth failed; not retrying")
            return
        super().retry_connect()

    def on_open(self, wsapp):
        logger.info("[Angel] Order status websocket connected")
        self._loop.call_soon_threadsafe(self._event_queue.put_nowait, ("open", None))

    def on_message(self, wsapp, message):
        self._loop.call_soon_threadsafe(self._event_queue.put_nowait, ("message", message))

    def on_close(self, wsapp, close_status_code=None, close_msg=None):
        self._loop.call_soon_threadsafe(
            self._event_queue.put_nowait,
            ("close", {"code": close_status_code, "message": close_msg}),
        )

    def on_error(self, wsapp, error):
        error_text = str(error)
        if "403" in error_text or "401" in error_text:
            self._auth_failed = True
        self._loop.call_soon_threadsafe(self._event_queue.put_nowait, ("error", error_text))


class AngelWebsocketOrderStatusClient(AngelClient):
    """Angel SmartAPI websocket order status feed."""

    def __init__(self):
        super().__init__()
        self._tracked_order_ids: set[str] = set()
        self._callbacks: list[StatusCallback] = []
        self.latest_update: dict[str, Any] | None = None
        self._running = False
        self._task: asyncio.Task | None = None
        self._thread: threading.Thread | None = None
        self._bridge: _AngelOrderUpdateBridge | None = None
        self._event_queue: asyncio.Queue | None = None

    @classmethod
    def from_trading_client(cls, client: AngelClient) -> AngelWebsocketOrderStatusClient:
        status_client = cls()
        status_client.api_key = client.api_key
        status_client.userid = client.userid
        status_client.mpin = client.mpin
        status_client.totp_key = client.totp_key
        status_client._client = client._client
        status_client._auth_token = getattr(client, "_auth_token", None) or client._client.access_token
        status_client._feed_token = getattr(client, "_feed_token", None) or client._client.feed_token
        return status_client

    def track_order(self, order_id: str | int) -> None:
        self._tracked_order_ids.add(str(order_id))

    def untrack_order(self, order_id: str | int) -> None:
        self._tracked_order_ids.discard(str(order_id))

    def add_status_callback(self, callback: StatusCallback) -> None:
        self._callbacks.append(callback)

    def get_latest_update(self) -> dict[str, Any] | None:
        return self.latest_update

    async def start(self) -> None:
        if self._running:
            return

        if not self.ensure_session_tokens():
            self.generate_session()
        if not self.ensure_session_tokens():
            raise RuntimeError("Angel order status websocket requires login tokens")

        loop = asyncio.get_running_loop()
        self._event_queue = asyncio.Queue()
        client_code = getattr(self._client, "userId", None) or self.userid
        self._bridge = _AngelOrderUpdateBridge(
            loop=loop,
            event_queue=self._event_queue,
            auth_token=self._auth_token,
            api_key=self.api_key,
            client_code=client_code,
            feed_token=self._feed_token,
        )
        self._running = True
        self._thread = threading.Thread(
            target=self._bridge.connect,
            name="angel-order-status",
            daemon=True,
        )
        self._thread.start()
        self._task = asyncio.create_task(self._consume_events())
        logger.info("[Angel] Order status websocket client started")

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
        logger.info("[Angel] Order status websocket client stopped")

    async def _consume_events(self) -> None:
        assert self._event_queue is not None

        while self._running:
            kind, payload = await self._event_queue.get()
            if kind == "message":
                await self._handle_message(payload)
            elif kind == "error":
                if "403" in payload:
                    logger.error(
                        "[Angel] Order status websocket rejected (403). "
                        "Angel docs: expired/invalid JWT — restart engine or re-login. Detail: %s",
                        payload,
                    )
                elif "401" in payload:
                    logger.error(
                        "[Angel] Order status websocket rejected (401 invalid token): %s",
                        payload,
                    )
                else:
                    logger.error("[Angel] Order status websocket error: %s", payload)
            elif kind == "close":
                logger.warning("[Angel] Order status websocket closed: %s", payload)

    async def _handle_message(self, raw_message: str) -> None:
        if raw_message == "pong":
            return

        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("[Angel] Ignoring non-JSON order status message: %s", raw_message)
            return

        logger.info("[Angel] Order status websocket JSON: %s", json.dumps(payload, default=str))

        order_data = payload.get("orderData") if isinstance(payload.get("orderData"), dict) else {}
        order_id = str(order_data.get("orderid") or order_data.get("orderId") or "").strip()
        order_status_code = str(payload.get("order-status") or payload.get("order_status") or "").upper()
        if order_status_code == "AB00":
            return
        if self._tracked_order_ids and (not order_id or order_id not in self._tracked_order_ids):
            return

        status = {
            "type": "angel_order_status_update",
            "order_id": order_id or None,
            "status": order_data.get("status") or order_data.get("orderstatus"),
            "order_status_code": payload.get("order-status") or payload.get("order_status"),
            "event_type": map_angel_order_status(payload),
            "source": "websocket",
            "content": order_data,
            "raw": payload,
        }
        self.latest_update = status
        await self._forward_status(status)

    async def _forward_status(self, status: dict[str, Any]) -> None:
        for callback in self._callbacks:
            try:
                result = callback(status)
                if result is not None:
                    await result
            except Exception as exc:
                logger.error("[Angel] Order status callback error: %s", exc)
