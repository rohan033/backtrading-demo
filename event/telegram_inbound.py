"""Optional long-poll of Telegram getUpdates to log inbound user messages."""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import requests
from logzero import logger

from event.telegram_config import TelegramConfig, load_telegram_config


def inbound_log_line(update: dict[str, Any]) -> str | None:
    """Build a log-safe one-line summary of a Telegram update, or None if not a text message."""
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    text = message.get("text") or message.get("caption")
    if text is None:
        return None

    chat_id = chat.get("id")
    chat_type = chat.get("type") or "?"
    username = sender.get("username") or ""
    first_name = sender.get("first_name") or ""
    sender_id = sender.get("id")
    sender_label = username or first_name or str(sender_id or "?")
    preview = str(text).replace("\n", " ")[:500]
    edited = " (edited)" if update.get("edited_message") else ""
    return (
        f"chat_id={chat_id} type={chat_type} from={sender_label} "
        f"sender_id={sender_id} text={preview!r}{edited}"
    )


_inbound_instance: TelegramInboundLogger | None = None


class TelegramInboundLogger:
    """Background getUpdates poller; logs messages users send to the bot."""

    def __init__(self, config: TelegramConfig, *, poll_timeout_seconds: int = 25):
        self.config = config
        self.poll_timeout_seconds = max(5, min(int(poll_timeout_seconds), 50))
        self._offset = 0
        self._stop = threading.Event()
        self._ensure_polling_mode()
        self._thread = threading.Thread(
            target=self._poll_loop,
            daemon=True,
            name="Telegram-Inbound-Log",
        )
        self._thread.start()
        logger.info(
            "[TELEGRAM] Inbound message logging started (getUpdates poll_timeout=%ss)",
            self.poll_timeout_seconds,
        )

    def _ensure_polling_mode(self) -> None:
        """getUpdates is ignored while a webhook is registered on the bot."""
        base = f"https://api.telegram.org/bot{self.config.bot_token}"
        try:
            response = requests.get(f"{base}/getWebhookInfo", timeout=15)
            if response.status_code >= 400:
                return
            url = (response.json().get("result") or {}).get("url") or ""
            if url:
                logger.warning(
                    "[TELEGRAM] Webhook was set (%s); deleting so getUpdates can receive messages",
                    url,
                )
                requests.post(f"{base}/deleteWebhook", timeout=15)
        except Exception as exc:
            logger.warning("[TELEGRAM] Could not verify webhook state: %s", exc)

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=self.poll_timeout_seconds + 5)
        logger.info("[TELEGRAM] Inbound message logging stopped")

    def _poll_loop(self) -> None:
        base = f"https://api.telegram.org/bot{self.config.bot_token}"
        while not self._stop.is_set():
            try:
                response = requests.get(
                    f"{base}/getUpdates",
                    params={
                        "offset": self._offset,
                        "timeout": self.poll_timeout_seconds,
                        "allowed_updates": '["message","edited_message"]',
                    },
                    timeout=self.poll_timeout_seconds + 10,
                )
                if response.status_code >= 400:
                    logger.error(
                        "[TELEGRAM] getUpdates failed status=%s body=%s",
                        response.status_code,
                        response.text[:500],
                    )
                    time.sleep(5)
                    continue

                payload = response.json()
                if not payload.get("ok"):
                    logger.error("[TELEGRAM] getUpdates not ok: %s", payload)
                    time.sleep(5)
                    continue

                for update in payload.get("result") or []:
                    if not isinstance(update, dict):
                        continue
                    update_id = update.get("update_id")
                    if isinstance(update_id, int):
                        self._offset = max(self._offset, update_id + 1)

                    line = inbound_log_line(update)
                    if line:
                        logger.info("[TELEGRAM] Inbound %s", line)
            except Exception as exc:
                if not self._stop.is_set():
                    logger.error("[TELEGRAM] Inbound poll error: %s", exc)
                    time.sleep(5)


def maybe_telegram_inbound_logger() -> TelegramInboundLogger | None:
    global _inbound_instance
    if _inbound_instance is not None:
        return _inbound_instance

    config = load_telegram_config()
    if config is None or not config.enabled:
        return None
    if not config.inbound_log:
        logger.info(
            "[TELEGRAM] Inbound message logging disabled (TELEGRAM_INBOUND_LOG=false)"
        )
        return None

    timeout = 25
    raw = os.getenv("TELEGRAM_INBOUND_POLL_TIMEOUT", "").strip()
    if raw.isdigit():
        timeout = int(raw)
    _inbound_instance = TelegramInboundLogger(config, poll_timeout_seconds=timeout)
    return _inbound_instance


def stop_telegram_inbound_logger() -> None:
    global _inbound_instance
    if _inbound_instance is None:
        return
    _inbound_instance.stop()
    _inbound_instance = None
