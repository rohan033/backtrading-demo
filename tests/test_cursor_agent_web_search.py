from api.cursor_agent import (
    WEB_SEARCH_DISABLED_HINT,
    WEB_SEARCH_ENABLED_HINT,
    _tool_call_blocked,
    _wrap_prompt,
)


def test_wrap_prompt_includes_web_search_enabled_hint():
    prompt = _wrap_prompt("Analyze INFY", new_agent=False, web_search_enabled=True)
    assert WEB_SEARCH_ENABLED_HINT in prompt
    assert "Do not check the codebase" not in prompt
    assert WEB_SEARCH_DISABLED_HINT not in prompt


def test_wrap_prompt_includes_web_search_disabled_hint():
    prompt = _wrap_prompt("Analyze INFY", new_agent=False, web_search_enabled=False)
    assert WEB_SEARCH_DISABLED_HINT in prompt
    assert "Do not use websearch" not in prompt
    assert WEB_SEARCH_ENABLED_HINT not in prompt


def test_tool_call_allowed_websearch_when_toggle_off():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "websearch", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=False,
    )
    assert blocked is False


def test_tool_call_allowed_when_web_search_enabled_in_ask_mode():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "websearch", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=True,
    )
    assert blocked is False


def test_tool_call_allowed_repo_read_with_web_search_on():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "read", "tool_status": "running", "path": "api/server.py"},
        interaction_mode="ask",
        web_search_enabled=True,
    )
    assert blocked is False


def test_wrap_prompt_execute_mode_prefers_mcp_tools():
    prompt = _wrap_prompt(
        "Create a strategy for INFY",
        new_agent=False,
        interaction_mode="execute",
        web_search_enabled=False,
    )
    assert "create_strategy" in prompt
    assert "POST /api/control/executions" not in prompt


def test_tool_call_allowed_for_trading_session_shell_curl():
    blocked, reason = _tool_call_blocked(
        {
            "tool_name": "shell",
            "tool_status": "running",
            "command": "curl -X POST http://127.0.0.1:8000/api/control/executions",
        },
        interaction_mode="execute",
        web_search_enabled=False,
        trading_session=True,
    )
    assert blocked is False
    assert reason == ""


def test_tool_call_blocked_when_shell_curls_control_plane_in_execute_mode():
    blocked, reason = _tool_call_blocked(
        {
            "tool_name": "shell",
            "tool_status": "running",
            "command": "curl -X POST http://127.0.0.1:8000/api/control/executions",
        },
        interaction_mode="execute",
        web_search_enabled=False,
    )
    assert blocked is True
    assert "create_strategy" in reason


def test_tool_call_allowed_when_mcp_create_strategy_used():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "create_strategy", "tool_status": "running"},
        interaction_mode="execute",
        web_search_enabled=False,
    )
    assert blocked is False


def test_tool_call_allowed_get_strategies_in_ask_mode():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "get_strategies", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=False,
    )
    assert blocked is False


def test_tool_call_allowed_search_instruments_in_ask_mode():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "search_instruments", "tool_status": "running", "args": '{"q":"INFY"}'},
        interaction_mode="ask",
        web_search_enabled=True,
    )
    assert blocked is False


def test_tool_call_allowed_create_strategy_in_ask_mode_by_default():
    blocked, _ = _tool_call_blocked(
        {"tool_name": "create_strategy", "tool_status": "running"},
        interaction_mode="ask",
        web_search_enabled=False,
    )
    assert blocked is False


def test_tool_call_blocked_create_strategy_in_ask_mode_when_strict_guardrails():
    import os
    from unittest.mock import patch

    with patch.dict(os.environ, {"CURSOR_AGENT_STRICT_ASK_GUARDRAILS": "true"}):
        blocked, reason = _tool_call_blocked(
            {"tool_name": "create_strategy", "tool_status": "running"},
            interaction_mode="ask",
            web_search_enabled=False,
        )
    assert blocked is True
    assert "Execute" in reason


def test_wrap_prompt_ask_mode_mentions_read_mcp_tools():
    prompt = _wrap_prompt("What strategies are saved?", new_agent=False, interaction_mode="ask")
    assert "get_*" in prompt
    assert "backtrading-control-plane" in prompt


def test_control_plane_mcp_attached_in_ask_mode():
    from api.cursor_sdk_bridge import control_plane_mcp_servers

    servers = control_plane_mcp_servers()
    assert servers is not None
    assert "backtrading-control-plane" in servers
