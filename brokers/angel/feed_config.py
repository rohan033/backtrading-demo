from __future__ import annotations

VALID_ANGEL_FEED_MODES = frozenset({"websocket", "rest"})
DEFAULT_ANGEL_FEED_MODE = "websocket"


def normalize_angel_feed_mode(value: str | None, *, default: str = DEFAULT_ANGEL_FEED_MODE) -> str:
    normalized = (value or default).strip().lower()
    if normalized in VALID_ANGEL_FEED_MODES:
        return normalized
    return default


def angel_uses_websocket_feed(value: str | None) -> bool:
    return normalize_angel_feed_mode(value) == "websocket"
