from control_plane.trading_session_agent_common import session_event_from_cursor


def test_session_tool_call_stores_mcp_args():
    event = {
        "type": "tool_call",
        "tool_name": "mcp",
        "tool_status": "running",
        "call_id": "tool_abc",
        "args": (
            '{"providerIdentifier":"backtrading-control-plane",'
            '"toolName":"search_instruments",'
            '"args":{"q":"NVDA","broker":"etoro","exchange":"ETORO","account_env":"demo"}}'
        ),
    }
    rows = session_event_from_cursor("explore", event, "run-1")
    assert len(rows) == 1
    _type, payload = rows[0]
    assert _type == "agent_tool_call"
    assert payload["tool_name"] == "search_instruments"
    assert payload["tool_source"] == "mcp"
    assert payload["call_id"] == "tool_abc"
    assert "NVDA" in payload["detail"]
    assert "q" in payload["args"]


def test_session_tool_call_merge_completed_keeps_args():
    running = {
        "type": "tool_call",
        "tool_name": "mcp",
        "tool_status": "running",
        "call_id": "tool_abc",
        "args": (
            '{"providerIdentifier":"backtrading-control-plane",'
            '"toolName":"get_historical_candles",'
            '"args":{"token":"1137","interval":"FOUR_HOUR"}}'
        ),
    }
    completed = {
        "type": "tool_call",
        "tool_name": "mcp",
        "tool_status": "completed",
        "call_id": "tool_abc",
        "result": '{"status":"success"}',
    }
    _t1, running_payload = session_event_from_cursor("explore", running, "run-1")[0]
    _t2, completed_payload = session_event_from_cursor("explore", completed, "run-1")[0]
    assert running_payload["tool_name"] == "get_historical_candles"
    assert "1137" in running_payload["args"]
    assert completed_payload["tool_status"] == "completed"
