"""Telegram notifications for manual UI position closes."""

from __future__ import annotations

import logging
from typing import Any

from event.platform_notifier import emit_position_closed_event
from event.telegram_format import format_ui_position_closed_message

log = logging.getLogger("backtrading")


def notify_ui_position_closed(details: dict[str, Any]) -> None:
    """Send a Telegram message for a UI-initiated position close."""
    if not details:
        return
    try:
        text = format_ui_position_closed_message(details)
        emit_position_closed_event(details.get("position_id"), details, text=text)
    except Exception as exc:
        log.error("[TELEGRAM] UI position close notify failed: %s", exc, exc_info=True)
