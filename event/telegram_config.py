import os
from dataclasses import dataclass

from event.strategy_events import STRATEGY_LIFECYCLE_ACTIONS

DEFAULT_NOTIFY_ACTIONS = frozenset({
    "BUY_ORDER_PLACED",
    "SELL_ORDER_PLACED",
    "ORDER_FILLED",
    "ORDER_CANCELLED",
    "ORDER_REJECTED",
    "ORDER_OPEN",
    "ORDER_PENDING",
    "ORDER_MODIFIED",
    "POSITION_CLOSED",
    "TAKE_PROFIT_EXIT_PLACED",
    "STOP_LOSS_EXIT_PLACED",
    "take_profit_triggered",
    "stop_loss_triggered",
    *STRATEGY_LIFECYCLE_ACTIONS,
})


@dataclass(frozen=True)
class TelegramConfig:
    bot_token: str
    chat_id: str
    notify_actions: frozenset[str]
    parse_mode: str | None = None
    disable_notification: bool = False

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.chat_id)


def _parse_bool(value: str | None, *, default: bool) -> bool:
    if value is None or not str(value).strip():
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _parse_actions(raw: str | None) -> frozenset[str]:
    if not raw or not raw.strip():
        return DEFAULT_NOTIFY_ACTIONS
    parts = {part.strip() for part in raw.split(",") if part.strip()}
    return frozenset(parts) if parts else DEFAULT_NOTIFY_ACTIONS


def load_telegram_config() -> TelegramConfig | None:
    """Load Telegram settings from env. Returns None when not configured."""
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return None

    explicit = os.getenv("TELEGRAM_ENABLED")
    if explicit is not None and not _parse_bool(explicit, default=True):
        return None

    parse_mode = os.getenv("TELEGRAM_PARSE_MODE", "").strip() or None
    if parse_mode and parse_mode.upper() not in {"HTML", "MARKDOWN", "MARKDOWNV2"}:
        parse_mode = None

    return TelegramConfig(
        bot_token=token,
        chat_id=chat_id,
        notify_actions=_parse_actions(os.getenv("TELEGRAM_NOTIFY_ACTIONS")),
        parse_mode=parse_mode,
        disable_notification=_parse_bool(os.getenv("TELEGRAM_SILENT"), default=False),
    )
