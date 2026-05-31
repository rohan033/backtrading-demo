from __future__ import annotations

import json
import re
from typing import Any

from control_plane.execution_sources import EXECUTION_SOURCE_AI_RESEARCH
from api.control_plane_mcp_tools import CREATE_STRATEGY_TOOL_RE as _CREATE_EXECUTION_TOOL_RE

_EXECUTION_ID_RE = re.compile(r'"execution_id"\s*:\s*"([^"]+)"')
_PATH_EXECUTION_ID_RE = re.compile(r"/api/control/executions/([^/\"'\s]+)")
_TICKER_IN_TITLE_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,5})\b")
_TITLE_TICKER_SKIP = frozenset({
    "OPEN",
    "SEC",
    "AI",
    "ETF",
    "IPO",
    "CHIPS",
    "LIVE",
    "POST",
    "EDT",
    "EST",
    "USA",
    "USD",
    "API",
    "MCP",
    "Q",
    "K",
})


def normalize_symbol(value: str) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    return text.split("-")[0].split(".")[0]


def symbol_from_title(title: str) -> str | None:
    for match in _TICKER_IN_TITLE_RE.finditer(str(title or "").upper()):
        token = match.group(1)
        if token in _TITLE_TICKER_SKIP:
            continue
        return token
    return None


def symbol_from_action(action: dict[str, Any]) -> str | None:
    payload = action.get("payload") or {}
    raw = str(payload.get("symbol") or "").strip()
    if raw:
        return normalize_symbol(raw) or None
    return symbol_from_title(str(action.get("title") or ""))


def symbol_from_engine(engine: dict[str, Any]) -> str | None:
    metadata = engine.get("metadata") or {}
    config = metadata.get("execution_config") or {}
    raw = str(engine.get("symbol") or config.get("symbol") or "").strip()
    if not raw:
        return None
    return normalize_symbol(raw) or None


def symbols_match(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    return normalize_symbol(left) == normalize_symbol(right)


def execution_has_research_source(metadata: dict[str, Any] | None) -> bool:
    metadata = metadata or {}
    config = metadata.get("execution_config") or {}
    return (
        metadata.get("source_id") == EXECUTION_SOURCE_AI_RESEARCH
        and bool(metadata.get("source_meta_id") or config.get("source_meta_id"))
    )


def apply_research_source_to_engine(
    registry: Any,
    execution_id: str,
    session_id: str,
) -> dict[str, Any] | None:
    engine = registry.get_engine(execution_id)
    if not engine:
        return None

    metadata = dict(engine.get("metadata") or {})
    config = dict(metadata.get("execution_config") or {})
    metadata["source_id"] = EXECUTION_SOURCE_AI_RESEARCH
    metadata["source_meta_id"] = session_id
    config["source_id"] = EXECUTION_SOURCE_AI_RESEARCH
    config["source_meta_id"] = session_id
    metadata["execution_config"] = config
    return registry.update_engine(execution_id, {"metadata": metadata})


def ensure_research_source_on_engine(registry: Any, store: Any, engine: dict[str, Any]) -> dict[str, Any]:
    metadata = engine.get("metadata") or {}
    if execution_has_research_source(metadata):
        return engine

    session_id = store.find_research_session_for_execution(engine["id"], engine)
    if not session_id:
        return engine

    updated = apply_research_source_to_engine(registry, engine["id"], session_id)
    return updated or engine


def extract_execution_id_from_tool_payload(payload: dict[str, Any]) -> str | None:
    for key in (
        "path",
        "content",
        "output",
        "result",
        "response",
        "args",
        "input",
        "arguments",
        "parameters",
        "command",
    ):
        value = payload.get(key)
        if not value:
            continue
        if isinstance(value, dict):
            execution_id = value.get("execution_id")
            if execution_id:
                return str(execution_id)
            data = value.get("data")
            if isinstance(data, dict) and data.get("execution_id"):
                return str(data["execution_id"])
            text = json.dumps(value)
        else:
            text = str(value)
        path_match = _PATH_EXECUTION_ID_RE.search(text)
        if path_match:
            return path_match.group(1)
        match = _EXECUTION_ID_RE.search(text)
        if match:
            return match.group(1)
    return None


def tool_call_links_research_execution(payload: dict[str, Any]) -> bool:
    if tool_call_created_execution(payload):
        return True
    tool_name = str(payload.get("tool_name") or "").strip().lower().replace("-", "_")
    return tool_name in {"start_strategy", "create_strategy"}


def action_status_for_engine(engine: dict[str, Any]) -> str:
    status = str(engine.get("status") or "").lower()
    if status in {"running", "starting", "stale"}:
        return "running"
    if status == "scheduled":
        return "scheduled"
    if status == "stopped":
        return "saved"
    return "saved"


def action_payload_matches_engine(action: dict[str, Any], engine: dict[str, Any]) -> bool:
    payload = action.get("payload") or {}
    if payload.get("execution_id"):
        return False

    action_symbol = symbol_from_action(action)
    engine_symbol = symbol_from_engine(engine)
    if not action_symbol or not engine_symbol:
        return False
    if not symbols_match(action_symbol, engine_symbol):
        return False

    metadata = engine.get("metadata") or {}
    config = metadata.get("execution_config") or {}
    executor = metadata.get("executor_payload") or {}
    token = str(engine.get("token") or config.get("token") or "")
    broker = str(engine.get("broker") or config.get("broker") or "")

    payload_token = str(payload.get("token") or "")
    if payload_token and token and payload_token != token:
        return False

    payload_broker = str(payload.get("broker") or "")
    if broker and payload_broker and payload_broker != broker:
        return False

    try:
        action_close = float(payload.get("close_price") or 0)
        engine_close = float(executor.get("close_price") or config.get("close_price") or 0)
    except (TypeError, ValueError):
        return True

    if action_close and engine_close:
        return abs(action_close - engine_close) <= 0.01
    return True


def engine_belongs_to_research_session(engine: dict[str, Any], session_id: str) -> bool:
    metadata = engine.get("metadata") or {}
    config = metadata.get("execution_config") or {}
    if metadata.get("source_id") != EXECUTION_SOURCE_AI_RESEARCH:
        return False
    meta_id = str(metadata.get("source_meta_id") or config.get("source_meta_id") or "")
    return meta_id == session_id


def tool_call_created_execution(payload: dict[str, Any]) -> bool:
    blob = " ".join(
        str(payload.get(key) or "")
        for key in ("tool_name", "content", "output", "result", "response", "args", "input", "arguments", "path")
    )
    return bool(_CREATE_EXECUTION_TOOL_RE.search(blob))
