"""Telegram channel (shim to event.telegram_* during migration)."""

from event.telegram_client import send_telegram_message, chunk_telegram_text
from event.telegram_config import TelegramConfig, load_telegram_config

__all__ = [
    "send_telegram_message",
    "chunk_telegram_text",
    "TelegramConfig",
    "load_telegram_config",
]
