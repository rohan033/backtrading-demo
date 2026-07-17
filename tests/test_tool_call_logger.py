import json
from types import SimpleNamespace

from api.tool_call_logger import (
    append_tool_call_log,
    build_tool_call_log_entry,
    format_tool_log_name,
    tool_call_log_path,
)


def test_format_mcp_fqdn_from_generic_mcp_args():
    event = {
        "tool_name": "mcp",
        "args": {
            "providerIdentifier": "backtrading-control-plane",
            "toolName": "search_instruments",
            "q": "NVDA",
        },
    }
    assert format_tool_log_name("mcp", event) == "mcp_backtrading_control_plane_search_instruments"


def test_format_mcp_fqdn_from_server_slash_tool():
    assert format_tool_log_name("backtrading-control-plane/search_instruments") == (
        "mcp_backtrading_control_plane_search_instruments"
    )


def test_format_mcp_fqdn_from_bare_control_plane_tool():
    assert format_tool_log_name("create_strategy") == (
        "mcp_backtrading_control_plane_create_strategy"
    )


def test_format_existing_mcp_prefix_normalized():
    assert format_tool_log_name("MCP_Backtrading-Control-Plane_Get_Strategies") == (
        "mcp_backtrading_control_plane_get_strategies"
    )


def test_format_non_mcp_uses_raw_name():
    assert format_tool_log_name("Grep") == "Grep"


def test_build_tool_call_log_entry_includes_tool_prefix_and_json_data(monkeypatch, tmp_path):
    monkeypatch.setenv("CURSOR_TOOL_CALL_LOG", str(tmp_path / "tools.jsonl"))
    message = SimpleNamespace(
        name="search_instruments",
        status="running",
        call_id="call-1",
        args={"q": "NVDA"},
        truncated=False,
    )
    payload = {
        "message_type": "tool_call",
        "tool_name": "search_instruments",
        "tool_status": "running",
        "call_id": "call-1",
        "args": '{"q":"NVDA"}',
    }
    entry = build_tool_call_log_entry(
        message=message,
        payload=payload,
        session_name="agent:test",
        agent_id="agent-1",
        run_id="run-1",
    )
    assert entry["tool"] == "[TOOL] mcp_backtrading_control_plane_search_instruments"
    assert entry["name"] == "mcp_backtrading_control_plane_search_instruments"
    assert entry["data"]["status"] == "running"
    assert entry["data"]["args"] == {"q": "NVDA"}
    assert entry["session_name"] == "agent:test"
    assert entry["run_id"] == "run-1"

    append_tool_call_log(entry)
    lines = (tmp_path / "tools.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["tool"].startswith("[TOOL] mcp_")


def test_tool_call_log_disabled(monkeypatch):
    monkeypatch.setenv("CURSOR_TOOL_CALL_LOG", "off")
    assert tool_call_log_path() is None
