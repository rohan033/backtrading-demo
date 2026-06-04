"""Async long-poll Telegram getUpdates for inbound logging and handlers."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from logzero import logger

from event.telegram_config import TelegramConfig, load_telegram_config

InboundHandler = Callable[[dict[str, Any]], None | Awaitable[None]]

_inbound_task: asyncio.Task[None] | None = None
_poller: "TelegramInboundPoller | None" = None
_handlers: list[InboundHandler] = []


def inbound_text_message(update: dict[str, Any]) -> dict[str, Any] | None:
    """Extract chat id and text from a message update."""
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None

    text = message.get("text") or message.get("caption")
    if text is None:
        return None

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return None

    sender = message.get("from") or {}
    return {
        "chat_id": chat_id,
        "text": str(text),
        "message_id": message.get("message_id"),
        "username": sender.get("username"),
        "sender_id": sender.get("id"),
        "edited": update.get("edited_message") is not None,
    }


def inbound_log_line(update: dict[str, Any]) -> str | None:
    """Build a log-safe one-line summary of a Telegram update, or None if not a text message."""
    message = inbound_text_message(update)
    if message is None:
        return None

    username = message.get("username") or ""
    sender_id = message.get("sender_id")
    sender_label = username or str(sender_id or "?")
    preview = str(message["text"]).replace("\n", " ")[:500]
    edited = " (edited)" if message.get("edited") else ""
    return (
        f"chat_id={message['chat_id']} from={sender_label} "
        f"sender_id={sender_id} text={preview!r}{edited}"
    )


def register_inbound_handler(handler: InboundHandler) -> None:
    if handler not in _handlers:
        _handlers.append(handler)


async def _dispatch_update(update: dict[str, Any], *, log_inbound: bool) -> None:
    if log_inbound:
        line = inbound_log_line(update)
        if line:
            logger.info("[TELEGRAM] Inbound %s", line)

    for handler in _handlers:
        try:
            result = handler(update)
            if asyncio.iscoroutine(result):
                await result
        except Exception as exc:
            logger.exception("[TELEGRAM] Inbound handler error: %s", exc)


class TelegramInboundPoller:
    """Cancellable asyncio getUpdates poller."""

    def __init__(
        self,
        config: TelegramConfig,
        *,
        poll_timeout_seconds: int = 25,
        log_inbound: bool = True,
    ):
        self.config = config
        self.poll_timeout_seconds = max(1, min(int(poll_timeout_seconds), 50))
        self.log_inbound = log_inbound
        self._offset = 0
        self._running = False

    @property
    def api_base(self) -> str:
        return f"https://api.telegram.org/bot{self.config.bot_token}"

    def _http_timeout(self) -> httpx.Timeout:
        # Slightly longer than Telegram long-poll window.
        read_seconds = float(self.poll_timeout_seconds + 5)
        return httpx.Timeout(connect=10.0, read=read_seconds, write=10.0, pool=10.0)

    async def _ensure_polling_mode(self, client: httpx.AsyncClient) -> None:
        """getUpdates is ignored while a webhook is registered on the bot."""
        try:
            response = await client.get(f"{self.api_base}/getWebhookInfo")
            if response.status_code >= 400:
                return
            url = (response.json().get("result") or {}).get("url") or ""
            if url:
                logger.warning(
                    "[TELEGRAM] Webhook was set (%s); deleting so getUpdates can receive messages",
                    url,
                )
                await client.post(f"{self.api_base}/deleteWebhook")
        except Exception as exc:
            logger.warning("[TELEGRAM] Could not verify webhook state: %s", exc)

    async def run(self) -> None:
        self._running = True
        logger.info(
            "[TELEGRAM] Inbound poller started (timeout=%ss log=%s handlers=%d)",
            self.poll_timeout_seconds,
            self.log_inbound,
            len(_handlers),
        )
        try:
            async with httpx.AsyncClient(timeout=self._http_timeout()) as client:
                await self._ensure_polling_mode(client)
                while self._running:
                    try:
                        response = await client.get(
                            f"{self.api_base}/getUpdates",
                            params={
                                "offset": self._offset,
                                "timeout": self.poll_timeout_seconds,
                                "allowed_updates": '["message","edited_message"]',
                            },
                        )
                    except asyncio.CancelledError:
                        raise
                    except httpx.TimeoutException:
                        if not self._running:
                            break
                        continue
                    except httpx.HTTPError as exc:
                        if not self._running:
                            break
                        logger.error("[TELEGRAM] Inbound poll error: %s", exc)
                        await asyncio.sleep(5)
                        continue

                    if response.status_code >= 400:
                        logger.error(
                            "[TELEGRAM] getUpdates failed status=%s body=%s",
                            response.status_code,
                            response.text[:500],
                        )
                        await asyncio.sleep(5)
                        continue

                    payload = response.json()
                    if not payload.get("ok"):
                        logger.error("[TELEGRAM] getUpdates not ok: %s", payload)
                        await asyncio.sleep(5)
                        continue

                    for update in payload.get("result") or []:
                        if not isinstance(update, dict):
                            continue
                        update_id = update.get("update_id")
                        if isinstance(update_id, int):
                            self._offset = max(self._offset, update_id + 1)
                        await _dispatch_update(update, log_inbound=self.log_inbound)
        finally:
            self._running = False
            logger.info("[TELEGRAM] Inbound poller stopped")

    def stop(self) -> None:
        self._running = False


def _poll_timeout_seconds() -> int:
    raw = os.getenv("TELEGRAM_INBOUND_POLL_TIMEOUT", "").strip()
    return int(raw) if raw.isdigit() else 25


async def start_telegram_inbound_services() -> None:
    """Start inbound polling and optional Telegram→Cursor agent bridge."""
    global _inbound_task, _poller

    if _inbound_task is not None:
        return

    from event.telegram_cursor_agent import maybe_start_telegram_cursor_agent

    config = load_telegram_config()
    if config is None or not config.enabled:
        return

    if config.cursor_agent:
        maybe_start_telegram_cursor_agent()
        from event.telegram_client import sync_telegram_bot_commands

        if sync_telegram_bot_commands(config):
            logger.info("[TELEGRAM] Bot commands synced with Telegram")

    if not (config.inbound_log or config.cursor_agent):
        return

    _poller = TelegramInboundPoller(
        config,
        poll_timeout_seconds=_poll_timeout_seconds(),
        log_inbound=config.inbound_log,
    )
    _inbound_task = asyncio.create_task(_poller.run(), name="Telegram-Inbound-Poll")


async def stop_telegram_inbound_services() -> None:
    """Cancel inbound polling quickly on application shutdown."""
    global _inbound_task, _poller

    from event.telegram_cursor_agent import stop_telegram_cursor_agent

    stop_telegram_cursor_agent()

    if _inbound_task is None:
        return

    if _poller is not None:
        _poller.stop()

    _inbound_task.cancel()
    try:
        await _inbound_task
    except asyncio.CancelledError:
        pass

    _inbound_task = None
    _poller = None


def maybe_telegram_inbound_logger() -> TelegramInboundPoller | None:
    """Return the active poller if the async lifespan already started it."""
    return _poller
