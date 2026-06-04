import queue
import threading
from typing import Any

import requests
from logzero import logger

from event.telegram_config import TelegramConfig, load_telegram_config
from event.telegram_format import format_telegram_event  # noqa: F401 — re-export


class TelegramEventListener:
    """Async queue consumer that posts trading events to a Telegram chat."""

    def __init__(self, config: TelegramConfig):
        self.config = config
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=500)
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._worker,
            daemon=True,
            name="EventListener-Telegram",
        )
        self._thread.start()
        logger.info("[TELEGRAM] Event listener started chat_id=%s", config.chat_id)

    def enqueue(self, order_id: str | None, action: str, details: dict[str, Any]) -> None:
        if action not in self.config.notify_actions:
            return
        event = {
            "order_id": order_id,
            "action": action,
            "details": details,
        }
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            logger.warning("[TELEGRAM] Queue full, dropping action=%s", action)

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)
        logger.info("[TELEGRAM] Event listener stopped")

    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                event = self._queue.get(timeout=1)
            except queue.Empty:
                continue
            try:
                text = format_telegram_event(
                    event.get("order_id"),
                    event["action"],
                    event.get("details") or {},
                )
                self._send_message(text)
            except Exception as exc:
                logger.error("[TELEGRAM] Failed to send event: %s", exc)

    def _send_message(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.config.bot_token}/sendMessage"
        parse_mode = self.config.parse_mode
        if parse_mode is None and text.lstrip().startswith("<"):
            parse_mode = "HTML"
        payload: dict[str, Any] = {
            "chat_id": self.config.chat_id,
            "text": text[:4096],
            "disable_notification": self.config.disable_notification,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode

        response = requests.post(url, json=payload, timeout=15)
        if response.status_code >= 400:
            logger.error(
                "[TELEGRAM] sendMessage failed status=%s body=%s",
                response.status_code,
                response.text[:500],
            )
            return
        logger.debug("[TELEGRAM] Message sent (%d chars)", len(text))


def maybe_telegram_listener() -> TelegramEventListener | None:
    config = load_telegram_config()
    if config is None or not config.enabled:
        return None
    return TelegramEventListener(config)
