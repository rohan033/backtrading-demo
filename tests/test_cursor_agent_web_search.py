from api.cursor_agent import (
    WEB_SEARCH_DISABLED_HINT,
    WEB_SEARCH_ENABLED_HINT,
    _tool_call_blocked,
    _wrap_prompt,
)


def test_wrap_prompt_includes_web_search_enabled_hint():
    prompt = _wrap_prompt("Analyze INFY", new_agent=False, web_search_enabled=True)
    assert WEB_SEARCH_ENABLED_HINT in prompt
    assert WEB_SEARCH_DISABLED_HINT not in prompt


def test_wrap_prompt_includes_web_search_disabled_hint():
    prompt = _wrap_prompt("Analyze INFY", new_agent=False, web_search_enabled=False)
    assert WEB_SEARCH_DISABLED_HINT in prompt
    assert WEB_SEARCH_ENABLED_HINT not in prompt


def test_tool_call_blocked_when_web_search_disabled():
    blocked, reason = _tool_call_blocked(
        {"tool_name": "websearch", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=False,
    )
    assert blocked is True
    assert "Web search is turned off" in reason


def test_tool_call_allowed_when_web_search_enabled_in_ask_mode():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "websearch", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=True,
    )
    assert blocked is False


def test_tool_call_blocked_when_web_search_disabled_in_execute_mode():
    blocked, reason = _tool_call_blocked(
        {"tool_name": "webfetch", "tool_status": "running"},
        interaction_mode="execute",
        web_search_enabled=False,
    )
    assert blocked is True
    assert "Web search is turned off" in reason
