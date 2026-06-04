from event.telegram_client import chunk_telegram_text
from event.telegram_commands import (
    InboundKind,
    bot_commands_for_api,
    command_question,
    help_text,
    is_new_message,
    is_stop_message,
    parse_agent_prompt,
    parse_bot_command,
    parse_continue_message,
    parse_resume_message,
    resolve_inbound_agent_prompt,
    resolve_inbound_agent_request,
)
from event.telegram_agent_prompt import (
    TELEGRAM_CONTINUING_HINT,
    TELEGRAM_SESSION_NAME,
    TELEGRAM_SESSION_RESUME_HINT,
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


def test_parse_bot_commands():
    assert parse_bot_command("/marketmood") == ("marketmood", "")
    assert parse_bot_command("/suggest tech only") == ("suggest", "tech only")
    assert parse_bot_command("/psuggest@MyBot") == ("psuggest", "")
    assert parse_bot_command("hello") is None


def test_resolve_inbound_bot_commands():
    req = resolve_inbound_agent_request("/marketmood")
    assert req is not None
    assert req.new_session is False
    assert "market mood" in req.question.lower()

    req = resolve_inbound_agent_request("/suggest")
    assert req is not None
    assert req.new_session is False

    req = resolve_inbound_agent_request("/psuggest")
    assert req is not None
    assert req.new_session is False

    q, fresh = resolve_inbound_agent_prompt("/suggest small caps")
    assert "small caps" in q
    assert fresh is False

    q, fresh = resolve_inbound_agent_prompt("/start")
    assert q == ""
    assert fresh is False

    req = resolve_inbound_agent_request("agent follow up")
    assert req is not None
    assert req.new_session is False
    assert req.question == "follow up"

    q, fresh = resolve_inbound_agent_prompt("agent follow up")
    assert q == "follow up"
    assert fresh is False


def test_continue_and_resume_requests():
    req = resolve_inbound_agent_request("/continue")
    assert req is not None
    assert req.kind == InboundKind.RUN
    assert req.use_last_session is True
    assert req.resume_with_summary is True
    assert req.agent_id is None

    req = resolve_inbound_agent_request("/continue what about NVDA?")
    assert req is not None
    assert "NVDA" in req.question
    assert req.use_last_session is True

    req = resolve_inbound_agent_request("/resume sess-abc")
    assert req is not None
    assert req.agent_id == "sess-abc"
    assert req.resume_with_summary is True

    req = resolve_inbound_agent_request("/resume sess-abc check positions")
    assert req is not None
    assert req.agent_id == "sess-abc"
    assert req.question == "check positions"


def test_parse_continue_and_resume_helpers():
    assert parse_continue_message("continue") == ""
    assert parse_continue_message("/continue hi") == "hi"
    assert parse_continue_message("hello") is None
    assert parse_resume_message("/resume id1") == ("id1", parse_resume_message("/resume id1")[1])
    assert parse_resume_message("/resume id1 do work") == ("id1", "do work")


def test_command_question_unknown():
    assert command_question("unknown") is None


def test_help_text_lists_commands():
    text = help_text()
    assert "/marketmood" in text
    assert "/suggest" in text
    assert "/psuggest" in text
    assert "/stop" in text
    assert "/new" in text
    assert "/continue" in text
    assert "/resume" in text
    assert "<session_id>" not in text
    assert "sess-1" in help_text("sess-1")


def test_bot_commands_for_api_includes_stop():
    names = {row["command"] for row in bot_commands_for_api()}
    assert names >= {"marketmood", "suggest", "psuggest", "stop", "continue", "new"}


def test_is_new_message():
    assert is_new_message("new")
    assert is_new_message("/new")
    assert is_new_message("/new@MyBot")
    assert not is_new_message("new york stocks")
    assert not is_new_message("/suggest")


def test_resolve_new_command():
    req = resolve_inbound_agent_request("/new")
    assert req is not None
    assert req.kind == InboundKind.NEW


def test_is_stop_message():
    assert is_stop_message("stop")
    assert is_stop_message("Stop")
    assert is_stop_message("/stop")
    assert is_stop_message("/stop@MyTradingBot")
    assert not is_stop_message("stop please")
    assert not is_stop_message("agent stop BBAI")


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
    assert "Section format" in wrapped
    assert "User question:" in wrapped
    assert "what is BBAI doing?" in wrapped
    assert TELEGRAM_WEB_SEARCH_HINT in wrapped
    assert TELEGRAM_SESSION_NAME == "telegram"


def test_build_telegram_agent_prompt_continuing_session():
    wrapped = build_telegram_agent_prompt("follow up", new_session=False)
    assert "User question:" in wrapped
    assert "follow up" in wrapped
    assert TELEGRAM_CONTINUING_HINT in wrapped
    assert "Telegram HTML limits" not in wrapped
    assert TELEGRAM_WEB_SEARCH_HINT not in wrapped


def test_build_telegram_agent_prompt_resume():
    wrapped = build_telegram_agent_prompt(
        "check NVDA",
        new_session=False,
        resume_with_summary=True,
    )
    assert TELEGRAM_SESSION_RESUME_HINT in wrapped
    assert "Session recap" in wrapped
    assert "check NVDA" in wrapped


def test_wrap_telegram_agent_prompt():
    wrapped = wrap_telegram_agent_prompt("what is BBAI doing?")
    assert "what is BBAI doing?" in wrapped


def test_telegram_channel_skill_instructions():
    instructions = telegram_channel_skill_instructions()
    assert TELEGRAM_CHANNEL_SKILL_NAME in instructions
    body = load_telegram_channel_skill_body()
    assert "Section format" in body
    assert "4 lines" in body or "4 bullet" in body


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
