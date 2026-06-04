import os
from unittest.mock import patch

from event.telegram_config import load_telegram_config
from event.telegram_format import format_telegram_event
from event.telegram_listener import maybe_telegram_listener


def test_format_telegram_event_buy():
    text = format_telegram_event(
        "42",
        "BUY_ORDER_PLACED",
        {
            "symbol": "IBM",
            "executor_id": "exec-1",
            "quantity": 10,
            "entry_price": 65.5,
            "take_profit_price": 70.0,
            "stop_loss_price": 60.0,
        },
    )
    assert "Buy order placed" in text
    assert "IBM" in text
    assert "42" in text
    assert "exec-1" in text
    assert "65.5" in text


def test_load_telegram_config_missing_env():
    with patch.dict(os.environ, {}, clear=True):
        assert load_telegram_config() is None


def test_load_telegram_config_from_env():
    with patch.dict(
        os.environ,
        {
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "12345",
            "TELEGRAM_NOTIFY_ACTIONS": "ORDER_FILLED,BUY_ORDER_PLACED",
        },
        clear=True,
    ):
        cfg = load_telegram_config()
        assert cfg is not None
        assert cfg.bot_token == "token"
        assert cfg.chat_id == "12345"
        assert cfg.notify_actions == frozenset({"ORDER_FILLED", "BUY_ORDER_PLACED"})


def test_maybe_telegram_listener_disabled():
    with patch.dict(os.environ, {}, clear=True):
        assert maybe_telegram_listener() is None


def test_notify_actions_filter():
    with patch.dict(
        os.environ,
        {
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_CHAT_ID": "99",
            "TELEGRAM_NOTIFY_ACTIONS": "ORDER_FILLED",
        },
        clear=True,
    ):
        cfg = load_telegram_config()
        assert cfg is not None
        assert "BUY_ORDER_PLACED" not in cfg.notify_actions
        assert "ORDER_FILLED" in cfg.notify_actions
