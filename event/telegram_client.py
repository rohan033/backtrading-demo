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
    plain: bool = False,
) -> tuple[bool, int | None]:
    """Send one message chunk. Returns (success, message_id)."""
    url = f"https://api.telegram.org/bot{config.bot_token}/sendMessage"
    if plain:
        mode = None
    elif parse_mode is not None:
        mode = parse_mode
    else:
        mode = config.parse_mode
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
        return False, None
    message_id: int | None = None
    try:
        result = response.json().get("result") or {}
        raw_id = result.get("message_id")
        if raw_id is not None:
            message_id = int(raw_id)
    except (TypeError, ValueError):
        message_id = None
    return True, message_id


def edit_telegram_message(
    config: TelegramConfig,
    chat_id: str | int,
    message_id: int,
    text: str,
    *,
    plain: bool = False,
) -> bool:
    """Edit an existing message. Returns True on success."""
    url = f"https://api.telegram.org/bot{config.bot_token}/editMessageText"
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text[:TELEGRAM_MESSAGE_LIMIT],
    }
    if not plain:
        mode = config.parse_mode
        if mode:
            payload["parse_mode"] = mode
    response = requests.post(url, json=payload, timeout=30)
    if response.status_code >= 400:
        logger.debug(
            "[TELEGRAM] editMessageText failed chat_id=%s message_id=%s status=%s body=%s",
            chat_id,
            message_id,
            response.status_code,
            response.text[:200],
        )
        return False
    return True


def delete_telegram_message(
    config: TelegramConfig,
    chat_id: str | int,
    message_id: int,
) -> bool:
    """Delete a message. Returns True on success."""
    url = f"https://api.telegram.org/bot{config.bot_token}/deleteMessage"
    response = requests.post(
        url,
        json={"chat_id": chat_id, "message_id": message_id},
        timeout=30,
    )
    if response.status_code >= 400:
        logger.debug(
            "[TELEGRAM] deleteMessage failed chat_id=%s message_id=%s status=%s",
            chat_id,
            message_id,
            response.status_code,
        )
        return False
    return True


def send_telegram_messages(
    config: TelegramConfig,
    chat_id: str | int,
    text: str,
    *,
    parse_mode: str | None = None,
    plain: bool = False,
) -> bool:
    """Send text, chunking if needed. Returns True if all chunks succeeded."""
    ok = True
    for chunk in chunk_telegram_text(text):
        chunk_ok, _ = send_telegram_message(
            config,
            chat_id,
            chunk,
            parse_mode=parse_mode,
            plain=plain,
        )
        if not chunk_ok:
            ok = False
            break
    return ok


def send_telegram_plain_message_with_id(
    config: TelegramConfig,
    chat_id: str | int,
    text: str,
) -> int | None:
    """Send plain text; return message_id on success."""
    ok, message_id = send_telegram_message(config, chat_id, text, plain=True)
    return message_id if ok else None


def send_telegram_plain_messages(
    config: TelegramConfig,
    chat_id: str | int,
    text: str,
) -> bool:
    """Send plain text, ignoring TELEGRAM_PARSE_MODE."""
    return send_telegram_messages(config, chat_id, text, plain=True)


def sync_telegram_bot_commands(config: TelegramConfig) -> bool:
    """Register bot commands with Telegram (setMyCommands). Returns True on success."""
    import os

    if os.getenv("TELEGRAM_SYNC_COMMANDS", "true").strip().lower() in {"0", "false", "no", "off"}:
        return False

    from event.telegram_commands import bot_commands_for_api

    url = f"https://api.telegram.org/bot{config.bot_token}/setMyCommands"
    response = requests.post(url, json={"commands": bot_commands_for_api()}, timeout=30)
    if response.status_code >= 400:
        logger.error(
            "[TELEGRAM] setMyCommands failed status=%s body=%s",
            response.status_code,
            response.text[:500],
        )
        return False
    return bool(response.json().get("ok"))


def send_telegram_html_reply(config: TelegramConfig, chat_id: str | int, text: str) -> None:
    """Send an HTML-formatted reply; fall back to plain text if Telegram rejects markup."""
    body = text.strip()
    if not body:
        return
    if send_telegram_messages(config, chat_id, body, parse_mode="HTML"):
        return
    logger.warning("[TELEGRAM] HTML send failed chat_id=%s; retrying as plain text", chat_id)
    send_telegram_plain_messages(config, chat_id, body)
