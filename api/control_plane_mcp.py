"""Control-plane MCP exposed over HTTP (mounted at /mcp on the FastAPI app)."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from fastmcp import FastMCP
from fastmcp.server.providers.openapi import MCPType, RouteMap

if TYPE_CHECKING:
    from fastapi import FastAPI

CONTROL_PLANE_MCP_PATH = "/mcp"
CONTROL_PLANE_MCP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def mount_control_plane_mcp(app: FastAPI) -> tuple[FastMCP, object]:
    """Build OpenAPI-derived MCP tools from the control plane and mount at /mcp."""
    control_plane_url = os.getenv("CONTROL_PLANE_URL", "http://127.0.0.1:8000").rstrip("/")

    mcp = FastMCP.from_fastapi(
        app=app,
        name="Backtrading Control Plane",
        httpx_client_kwargs={"base_url": control_plane_url},
        route_maps=[
            RouteMap(methods="*", pattern=r"^/api/control/.+/stream$", mcp_type=MCPType.EXCLUDE),
            RouteMap(methods=CONTROL_PLANE_MCP_METHODS, pattern=r"^/api/control", mcp_type=MCPType.TOOL),
            RouteMap(methods="*", pattern=r".*", mcp_type=MCPType.EXCLUDE),
        ],
    )
    mcp_app = mcp.http_app(path="/")
    app.mount(CONTROL_PLANE_MCP_PATH, mcp_app)
    return mcp, mcp_app
