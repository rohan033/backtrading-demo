from api.tool_call_names import (
    format_mcp_fqdn,
    is_generic_mcp_tool_name,
    resolve_cursor_tool_name,
)


def test_is_generic_mcp_tool_name():
    assert is_generic_mcp_tool_name("mcp")
    assert is_generic_mcp_tool_name("MCP")
    assert not is_generic_mcp_tool_name("search_instruments")


def test_resolve_cursor_tool_name_from_mcp_args():
    event = {
        "tool_name": "mcp",
        "args": (
            '{"providerIdentifier":"backtrading-control-plane",'
            '"toolName":"search_instruments",'
            '"args":{"q":"NVDA"}}'
        ),
    }
    assert resolve_cursor_tool_name(event) == "search_instruments"


def test_flatten_nested_mcp_args():
    from api.tool_call_names import flatten_mcp_tool_args

    flat = flatten_mcp_tool_args({
        "providerIdentifier": "backtrading-control-plane",
        "toolName": "search_instruments",
        "args": {"q": "NVDA", "broker": "etoro"},
    })
    assert flat == {"q": "NVDA", "broker": "etoro"}


def test_resolve_cursor_tool_name_keeps_non_mcp():
    event = {"tool_name": "grep", "args": '{"pattern":"foo"}'}
    assert resolve_cursor_tool_name(event) == "grep"


def test_format_mcp_fqdn():
    assert format_mcp_fqdn("backtrading-control-plane", "search_instruments") == (
        "mcp_backtrading_control_plane_search_instruments"
    )
