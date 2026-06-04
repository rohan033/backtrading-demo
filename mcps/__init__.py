"""MCP tool catalog (facade over api.control_plane_mcp_tools)."""

from mcps.catalog import (
    CREATE_STRATEGY_TOOL,
    CREATE_STRATEGY_TOOL_RE,
    CONTROL_PLANE_MCP_PATH,
    CONTROL_PLANE_MCP_SERVER,
    EXECUTE_CONTROL_PLANE_MCP_HINT,
)

try:
    from mcps.catalog import READ_CONTROL_PLANE_MCP_HINT
except ImportError:
    READ_CONTROL_PLANE_MCP_HINT = ""

__all__ = [
    "CREATE_STRATEGY_TOOL",
    "CREATE_STRATEGY_TOOL_RE",
    "CONTROL_PLANE_MCP_PATH",
    "CONTROL_PLANE_MCP_SERVER",
    "EXECUTE_CONTROL_PLANE_MCP_HINT",
    "READ_CONTROL_PLANE_MCP_HINT",
]
