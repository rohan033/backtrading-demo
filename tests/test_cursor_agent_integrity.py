"""Regression tests for Cursor agent / research session wiring."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

import api.cursor_agent as cursor_agent_mod
from api.cursor_agent import (
    _maybe_tag_research_execution_from_tool,
    _tool_call_blocked,
    _tool_call_text,
    _wrap_prompt,
)
from control_plane.execution_source_links import (
    apply_research_source_to_engine,
    extract_execution_id_from_tool_payload,
    tool_call_links_research_execution,
)


def test_cursor_agent_binds_research_link_helpers() -> None:
    assert cursor_agent_mod.tool_call_links_research_execution is tool_call_links_research_execution
    assert cursor_agent_mod.extract_execution_id_from_tool_payload is extract_execution_id_from_tool_payload
    assert cursor_agent_mod.apply_research_source_to_engine is apply_research_source_to_engine


def test_cursor_agent_imports_json_for_websocket_payloads() -> None:
    assert hasattr(cursor_agent_mod, "json")
    assert json.loads('{"type":"ping"}') == {"type": "ping"}


@pytest.mark.parametrize(
    "tool_status",
    ["running", "pending", "in_progress", "started", ""],
)
def test_maybe_tag_skips_non_terminal_tool_statuses(tool_status: str) -> None:
    _maybe_tag_research_execution_from_tool(
        "research-session-1",
        {"tool_name": "grep", "tool_status": tool_status, "args": '{"pattern":"foo"}'},
    )


@pytest.mark.parametrize(
    "tool_status",
    ["completed", "complete", "success", "succeeded", "done"],
)
def test_maybe_tag_completed_non_execution_tools_do_not_raise(tool_status: str) -> None:
    _maybe_tag_research_execution_from_tool(
        "research-session-1",
        {"tool_name": "grep", "tool_status": tool_status, "args": '{"pattern":"foo"}'},
    )


def test_maybe_tag_completed_create_strategy_without_execution_id_is_noop() -> None:
    _maybe_tag_research_execution_from_tool(
        "research-session-1",
        {"tool_name": "create_strategy", "tool_status": "completed", "args": "{}"},
    )


def test_tool_call_links_research_execution_for_create_strategy() -> None:
    payload = {"tool_name": "create_strategy", "tool_status": "completed"}
    assert tool_call_links_research_execution(payload) is True


def test_tool_call_links_research_execution_for_grep_is_false() -> None:
    payload = {"tool_name": "grep", "tool_status": "completed"}
    assert tool_call_links_research_execution(payload) is False


def test_extract_execution_id_from_tool_payload_json_blob() -> None:
    payload = {
        "tool_name": "create_strategy",
        "args": '{"execution_id":"demo-strategy-1"}',
    }
    assert extract_execution_id_from_tool_payload(payload) == "demo-strategy-1"


def test_tool_call_text_joins_known_fields() -> None:
    text = _tool_call_text(
        {
            "tool_name": "grep",
            "args": '{"pattern":"create_strategy"}',
            "path": "api/server.py",
        }
    )
    assert "grep" in text
    assert "create_strategy" in text
    assert "api/server.py" in text


def test_wrap_prompt_research_session_execute_includes_source_meta() -> None:
    prompt = _wrap_prompt(
        "Create a VERU strategy",
        new_agent=True,
        interaction_mode="execute",
        research_session_id="sess-123",
    )
    assert 'source_id "ai_research"' in prompt
    assert 'source_meta_id "sess-123"' in prompt


@pytest.mark.parametrize(
    "tool_name",
    ["grep", "read", "glob", "websearch", "get_strategies", "search_instruments"],
)
def test_readonly_tools_allowed_in_ask_mode(tool_name: str) -> None:
    blocked, _ = _tool_call_blocked(
        {"tool_name": tool_name, "tool_status": "completed"},
        interaction_mode="ask",
        web_search_enabled=True,
    )
    assert blocked is False


def test_maybe_tag_with_missing_engine_is_swallowed() -> None:
    with patch("control_plane.engine_registry.EngineRegistry") as registry_cls:
        registry = registry_cls.return_value
        registry.get_engine.return_value = None
        _maybe_tag_research_execution_from_tool(
            "research-session-1",
            {
                "tool_name": "create_strategy",
                "tool_status": "completed",
                "args": '{"execution_id":"missing-strategy"}',
            },
        )
