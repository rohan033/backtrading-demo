"""Resolve Cursor SDK tool names (generic ``mcp`` → concrete MCP tool)."""

from __future__ import annotations

import json
from typing import Any


def parse_tool_args_blob(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def flatten_mcp_tool_args(args: dict[str, Any] | None) -> dict[str, Any] | None:
    if not args:
        return None
    payload = dict(args)
    for key in ("providerIdentifier", "provider_identifier", "toolName", "tool_name"):
        payload.pop(key, None)
    nested = payload.pop("args", None)
    if isinstance(nested, dict):
        payload.update(nested)
    return payload or None


def tool_args_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("args", "input", "arguments", "parameters", "content", "detail"):
        parsed = parse_tool_args_blob(event.get(key))
        if parsed:
            return flatten_mcp_tool_args(parsed) or parsed
    return None


def is_generic_mcp_tool_name(tool_name: str | None) -> bool:
    return (tool_name or "").strip().lower() == "mcp"


def mcp_provider_and_tool(args: dict[str, Any] | None) -> tuple[str | None, str | None]:
    if not args:
        return None, None
    provider = args.get("providerIdentifier") or args.get("provider_identifier")
    tool = args.get("toolName") or args.get("tool_name")
    provider_text = str(provider).strip() if provider else None
    tool_text = str(tool).strip() if tool else None
    return provider_text or None, tool_text or None


def resolve_cursor_tool_name(event: dict[str, Any]) -> str:
    raw = str(event.get("tool_name") or "tool").strip() or "tool"
    if not is_generic_mcp_tool_name(raw):
        return raw
    for key in ("args", "input", "arguments", "parameters", "content", "detail"):
        parsed = parse_tool_args_blob(event.get(key))
        if not parsed:
            continue
        _provider, tool = mcp_provider_and_tool(parsed)
        if tool:
            return tool
    return raw


def format_mcp_fqdn(provider: str | None, tool: str | None) -> str | None:
    if not tool:
        return None
    if not provider:
        from api.control_plane_mcp_tools import CONTROL_PLANE_MCP_SERVER

        provider = CONTROL_PLANE_MCP_SERVER
    provider_slug = provider.lower().replace("-", "_")
    tool_slug = tool.lower().replace("-", "_")
    return f"mcp_{provider_slug}_{tool_slug}"
