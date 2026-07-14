"""Append Cursor SDK tool_call events to a JSONL audit log."""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from api.control_plane_mcp_tools import (
    CONTROL_PLANE_MCP_SERVER,
    is_mutation_mcp_tool_name,
    is_read_mcp_tool_name,
    normalize_mcp_tool_name,
)
from control_plane.engine_process_manager import REPO_ROOT

log = logging.getLogger("backtrading.tool_call_logger")

CURSOR_TOOL_CALL_LOG_ENV = "CURSOR_TOOL_CALL_LOG"
DEFAULT_TOOL_CALL_LOG = REPO_ROOT / "logs" / "cursor-tool-calls.jsonl"

_write_lock = threading.Lock()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def format_tool_log_name(raw_name: str | None, event: dict[str, Any] | None = None) -> str:
    """Return the full tool name; MCP tools use mcp_<server>_<tool> FQDN."""
    from api.tool_call_names import (
        format_mcp_fqdn,
        is_generic_mcp_tool_name,
        mcp_provider_and_tool,
        resolve_cursor_tool_name,
        tool_args_from_event,
    )

    if event:
        resolved = resolve_cursor_tool_name(event)
        if is_generic_mcp_tool_name(raw_name) and resolved != (raw_name or "").strip():
            args = tool_args_from_event(event)
            provider, tool = mcp_provider_and_tool(args)
            fqdn = format_mcp_fqdn(provider, tool)
            if fqdn:
                return fqdn
        if not is_generic_mcp_tool_name(resolved):
            name = resolved
        else:
            name = (raw_name or "tool").strip() or "tool"
    else:
        name = (raw_name or "tool").strip() or "tool"

    normalized = name.replace("-", "_")
    lower = normalized.lower()
    if lower.startswith("mcp_"):
        return lower

    for sep in ("/", "."):
        if sep in name:
            server, tool = name.rsplit(sep, 1)
            return f"mcp_{_slug(server)}_{_slug(tool)}"

    bare = normalize_mcp_tool_name(name)
    if is_read_mcp_tool_name(name) or is_mutation_mcp_tool_name(name):
        return f"mcp_{_slug(CONTROL_PLANE_MCP_SERVER)}_{bare}"

    return name


def _coerce_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return value
    with contextlib.suppress(TypeError, ValueError):
        return json.loads(json.dumps(value, default=str))
    return str(value)


def build_tool_call_data(message: Any, payload: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {}

    status = payload.get("tool_status") or getattr(message, "status", None)
    if status:
        data["status"] = status

    call_id = payload.get("call_id") or getattr(message, "call_id", None)
    if call_id:
        data["call_id"] = call_id

    truncated = getattr(message, "truncated", None)
    if truncated:
        data["truncated"] = truncated

    for key in ("args", "result"):
        value = payload.get(key)
        if value is None and hasattr(message, key):
            value = getattr(message, key)
        if value is not None:
            data[key] = _coerce_json_value(value)

    for key in ("input", "arguments", "command", "parameters", "path", "content"):
        if key in data or key in ("args", "result"):
            continue
        value = payload.get(key)
        if value is None and hasattr(message, key):
            value = getattr(message, key)
        if value is not None and key not in data:
            coerced = _coerce_json_value(value)
            if coerced is not None:
                data[key] = coerced

    return data


def build_tool_call_log_entry(
    *,
    message: Any,
    payload: dict[str, Any],
    session_name: str | None = None,
    agent_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    full_name = format_tool_log_name(
        payload.get("tool_name") or getattr(message, "name", None),
        {**payload, "tool_name": payload.get("tool_name") or getattr(message, "name", None)},
    )
    data = build_tool_call_data(message, payload)
    return {
        "logged_at": datetime.now(timezone.utc).isoformat(),
        "tool": f"[TOOL] {full_name}",
        "name": full_name,
        "session_name": session_name,
        "agent_id": agent_id,
        "run_id": run_id,
        "data": data,
    }


def tool_call_log_path() -> Path | None:
    raw = os.getenv(CURSOR_TOOL_CALL_LOG_ENV, "").strip()
    if raw.lower() in {"0", "false", "off", "none", "disabled"}:
        return None
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else REPO_ROOT / path
    return DEFAULT_TOOL_CALL_LOG


def append_tool_call_log(entry: dict[str, Any]) -> None:
    path = tool_call_log_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, default=str, ensure_ascii=False)
        with _write_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except Exception as exc:
        log.warning("[TOOL_CALL_LOG] failed to write %s: %s", path, exc)


def log_tool_call_event(
    *,
    message: Any,
    payload: dict[str, Any],
    session_name: str | None = None,
    agent_id: str | None = None,
    run_id: str | None = None,
) -> None:
    if payload.get("message_type") != "tool_call":
        return
    entry = build_tool_call_log_entry(
        message=message,
        payload=payload,
        session_name=session_name,
        agent_id=agent_id,
        run_id=run_id,
    )
    append_tool_call_log(entry)
