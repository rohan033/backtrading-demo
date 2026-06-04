"""Low-level Telegram Bot API helpers."""

from __future__ import annotations

from typing import Any

import requests
from logzero import logger

from event.telegram_config import TelegramConfig

TELEGRAM_MESSAGE_LIMIT = 4096


def chunk_telegram_text(text: str, *, limit: int = TELEGRAM_MESSAGE_LIMIT) -> list[str]:
    if len(text) <= limit:
        return [text]
    return [text[index:index + limit] for index in range(0, len(text), limit)]


def send_telegram_message(
    config: TelegramConfig,
    chat_id: str | int,
    text: str,
    *,
    parse_mode: str | None = None,
) -> bool:
    """Send one message chunk. Returns True on success."""
    url = f"https://api.telegram.org/bot{config.bot_token}/sendMessage"
    mode = parse_mode if parse_mode is not None else config.parse_mode
    if mode is None and text.lstrip().startswith("<"):
        mode = "HTML"
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text[:TELEGRAM_MESSAGE_LIMIT],
        "disable_notification": config.disable_notification,
    }
    if mode:
        payload["parse_mode"] = mode

    response = requests.post(url, json=payload, timeout=30)
    if response.status_code >= 400:
        logger.error(
            "[TELEGRAM] sendMessage failed chat_id=%s status=%s body=%s",
            chat_id,
            response.status_code,
            response.text[:500],
        )
        return False
    return True


def send_telegram_messages(
    config: TelegramConfig,
    chat_id: str | int,
    text: str,
    *,
    parse_mode: str | None = None,
) -> bool:
    """Send text, chunking if needed. Returns True if all chunks succeeded."""
    ok = True
    for chunk in chunk_telegram_text(text):
        if not send_telegram_message(config, chat_id, chunk, parse_mode=parse_mode):
            ok = False
            break
    return ok


def send_telegram_html_reply(config: TelegramConfig, chat_id: str | int, text: str) -> None:
    """Send an HTML-formatted reply; fall back to plain text if Telegram rejects markup."""
    body = text.strip()
    if not body:
        return
    if send_telegram_messages(config, chat_id, body, parse_mode="HTML"):
        return
    logger.warning("[TELEGRAM] HTML send failed chat_id=%s; retrying as plain text", chat_id)
    send_telegram_messages(config, chat_id, body, parse_mode=None)
