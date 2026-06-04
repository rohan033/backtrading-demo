from unittest.mock import MagicMock, patch

from event.telegram_client import send_telegram_message
from event.telegram_config import TelegramConfig


def _config(*, parse_mode: str | None = "HTML") -> TelegramConfig:
    return TelegramConfig(
        bot_token="token",
        chat_id="123",
        notify_actions=frozenset(),
        parse_mode=parse_mode,
    )


def test_send_telegram_message_plain_ignores_config_parse_mode():
    config = _config(parse_mode="HTML")
    with patch("event.telegram_client.requests.post") as post:
        response = MagicMock(status_code=200, text='{"ok":true,"result":{"message_id":1}}')
        response.json.return_value = {"ok": True, "result": {"message_id": 1}}
        post.return_value = response
        assert send_telegram_message(
            config,
            "123",
            "No saved session. Use /resume <session_id>.",
            plain=True,
        ) == (True, 1)
        payload = post.call_args.kwargs["json"]
        assert "parse_mode" not in payload


def test_send_telegram_message_inherits_html_parse_mode():
    config = _config(parse_mode="HTML")
    with patch("event.telegram_client.requests.post") as post:
        response = MagicMock(status_code=200, text='{"ok":true,"result":{"message_id":42}}')
        response.json.return_value = {"ok": True, "result": {"message_id": 42}}
        post.return_value = response
        ok, message_id = send_telegram_message(config, "123", "plain status")
        assert ok is True
        assert message_id == 42
        payload = post.call_args.kwargs["json"]
        assert payload.get("parse_mode") == "HTML"
        payload = post.call_args.kwargs["json"]
        assert payload.get("parse_mode") == "HTML"
