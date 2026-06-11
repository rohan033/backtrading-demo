from __future__ import annotations

VALID_ETORO_FEED_MODES = frozenset({"websocket", "rest", "polling"})
DEFAULT_ETORO_FEED_MODE = "websocket"


def normalize_etoro_feed_mode(value: str | None, *, default: str = DEFAULT_ETORO_FEED_MODE) -> str:
    normalized = (value or default).strip().lower()
    if normalized in {"rest", "polling"}:
        return "rest"
    if normalized == "websocket":
        return "websocket"
    return default


def etoro_uses_websocket_feed(value: str | None) -> bool:
    return normalize_etoro_feed_mode(value) == "websocket"


def normalize_feed_tick_sample_every(value: int | str | None) -> int:
    """0 means forward every websocket tick; N>0 forwards every Nth tick."""
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)
