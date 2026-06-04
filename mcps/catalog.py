"""MCP catalog facade — orchestration imports this instead of api.*."""

from api.control_plane_mcp import CONTROL_PLANE_MCP_PATH  # noqa: F401
from api.control_plane_mcp_tools import (  # noqa: F401
    CREATE_STRATEGY_TOOL,
    CREATE_STRATEGY_TOOL_RE,
    CONTROL_PLANE_MCP_SERVER,
    EXECUTE_CONTROL_PLANE_MCP_HINT,
    MCP_TOOL_DESCRIPTIONS,
)

from api.control_plane_mcp_tools import ASK_CONTROL_PLANE_READ_MCP_HINT as READ_CONTROL_PLANE_MCP_HINT  # noqa: F401

__all__ = [
    "CREATE_STRATEGY_TOOL",
    "CREATE_STRATEGY_TOOL_RE",
    "CONTROL_PLANE_MCP_PATH",
    "CONTROL_PLANE_MCP_SERVER",
    "EXECUTE_CONTROL_PLANE_MCP_HINT",
    "READ_CONTROL_PLANE_MCP_HINT",
    "MCP_TOOL_DESCRIPTIONS",
]
