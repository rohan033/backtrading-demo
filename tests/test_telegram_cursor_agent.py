from event.telegram_client import chunk_telegram_text
from event.telegram_cursor_agent import parse_agent_prompt
from event.telegram_agent_prompt import (
    TELEGRAM_SESSION_NAME,
    TELEGRAM_WEB_SEARCH_HINT,
    build_telegram_agent_prompt,
)
from event.telegram_format import (
    TELEGRAM_AGENT_REPLY_HINT,
    TELEGRAM_CHANNEL_SKILL_NAME,
    format_telegram_html_table,
    load_telegram_channel_skill_body,
    normalize_telegram_agent_reply,
    telegram_channel_skill_instructions,
    wrap_telegram_agent_prompt,
)


def test_parse_agent_prompt_with_query():
    assert parse_agent_prompt("agent what is BBAI doing?") == "what is BBAI doing?"
    assert parse_agent_prompt("Agent: create a strategy") == "create a strategy"
    assert parse_agent_prompt("/agent summarize my open positions") == "summarize my open positions"


def test_parse_agent_prompt_empty_shows_help():
    assert parse_agent_prompt("agent") == ""
    assert parse_agent_prompt("agent:") == ""


def test_parse_agent_prompt_non_command():
    assert parse_agent_prompt("hello there") is None
    assert parse_agent_prompt("my agent friend") is None


def test_chunk_telegram_text():
    text = "x" * 9000
    chunks = chunk_telegram_text(text)
    assert len(chunks) == 3
    assert sum(len(chunk) for chunk in chunks) == 9000


def test_build_telegram_agent_prompt():
    wrapped = build_telegram_agent_prompt("what is BBAI doing?", new_session=True)
    assert TELEGRAM_AGENT_REPLY_HINT in wrapped
    assert "You will be responding to the Telegram channel." in wrapped
    assert TELEGRAM_CHANNEL_SKILL_NAME in wrapped
    assert "Telegram HTML limits" in load_telegram_channel_skill_body()
    assert "Telegram HTML limits" in wrapped
    assert "User question:" in wrapped
    assert "what is BBAI doing?" in wrapped
    assert TELEGRAM_WEB_SEARCH_HINT in wrapped
    assert TELEGRAM_SESSION_NAME == "telegram"


def test_build_telegram_agent_prompt_continuing_session():
    wrapped = build_telegram_agent_prompt("follow up", new_session=False)
    assert "User question:" in wrapped
    assert "follow up" in wrapped
    assert "replying over Telegram" not in wrapped
    assert TELEGRAM_WEB_SEARCH_HINT in wrapped


def test_wrap_telegram_agent_prompt():
    wrapped = wrap_telegram_agent_prompt("what is BBAI doing?")
    assert "what is BBAI doing?" in wrapped


def test_telegram_channel_skill_instructions():
    instructions = telegram_channel_skill_instructions()
    assert TELEGRAM_CHANNEL_SKILL_NAME in instructions
    assert "<pre>" in load_telegram_channel_skill_body()


def test_normalize_telegram_agent_reply():
    assert normalize_telegram_agent_reply("<b>Hi</b>") == "<b>Hi</b>"
    assert normalize_telegram_agent_reply("```html\n<b>Hi</b>\n```") == "<b>Hi</b>"
    assert normalize_telegram_agent_reply("```\n<b>Hi</b>\n```") == "<b>Hi</b>"


def test_format_telegram_html_table():
    html = format_telegram_html_table(
        ["Symbol", "LTP"],
        [["BBAI", "$5.35"], ["IONQ", "$45.20"]],
        title="Open positions",
    )
    assert html.startswith("<b>Open positions</b>")
    assert "<pre>" in html
    assert "Symbol" in html
    assert "BBAI" in html
    assert "─" in html
    assert "<table>" not in html
