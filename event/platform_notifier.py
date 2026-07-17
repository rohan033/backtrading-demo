"""Control-plane event notifications (strategy lifecycle, etc.)."""

import logging
from typing import Any

from event.strategy_events import strategy_details_from_engine
from event.telegram_listener import TelegramEventListener, maybe_telegram_listener

log = logging.getLogger("backtrading")

_listeners: list[TelegramEventListener] = []


def _start_telegram_services() -> TelegramEventListener | None:
    global _listeners
    if _listeners:
        return _listeners[0]

    from event.telegram_env import load_telegram_env

    load_telegram_env()
    listener = maybe_telegram_listener()
    if listener is not None:
        _listeners.append(listener)
    return _listeners[0] if _listeners else None


def _telegram_listener() -> TelegramEventListener | None:
    return _start_telegram_services()


def emit_strategy_event(
    action: str,
    engine: dict[str, Any],
    *,
    previous_state: str | None = None,
    trigger: str | None = None,
    **extra: Any,
) -> None:
    """Notify listeners of a strategy lifecycle change."""
    execution_id = engine.get("id")
    if not execution_id:
        return

    details = strategy_details_from_engine(
        engine,
        previous_state=previous_state,
        trigger=trigger,
        **extra,
    )

    log.info(
        "[CONTROL] Strategy event %s execution=%s state=%s",
        action,
        execution_id,
        details.get("state"),
    )

    listener = _telegram_listener()
    if listener is None:
        return
    try:
        listener.enqueue(execution_id, action, details)
    except Exception as exc:
        log.error("[TELEGRAM] Strategy event enqueue failed %s: %s", action, exc)


def emit_position_closed_event(
    position_id: str | int | None,
    details: dict[str, Any],
    *,
    text: str | None = None,
) -> None:
    """Notify Telegram of a position close (UI or control-plane)."""
    listener = _telegram_listener()
    if listener is None:
        return
    payload = dict(details)
    if text:
        payload["_telegram_text"] = text
    try:
        listener.enqueue(
            str(position_id) if position_id is not None else None,
            "POSITION_CLOSED",
            payload,
        )
    except Exception as exc:
        log.error("[TELEGRAM] Position close enqueue failed: %s", exc)


def shutdown_platform_notifier() -> None:
    global _listeners
    for listener in _listeners:
        listener.stop()
    _listeners.clear()
