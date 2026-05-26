from __future__ import annotations

import json
import re
from typing import Any

from control_plane.execution_sources import EXECUTION_SOURCE_AI_RESEARCH

_EXECUTION_ID_RE = re.compile(r'"execution_id"\s*:\s*"([^"]+)"')
_CREATE_EXECUTION_TOOL_RE = re.compile(
    r"(create_controlled_execution|post_api_control_executions|/api/control/executions)",
    re.IGNORECASE,
)


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
    for key in ("content", "output", "result", "response", "args", "input", "arguments", "parameters"):
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
        match = _EXECUTION_ID_RE.search(text)
        if match:
            return match.group(1)
    return None


def tool_call_created_execution(payload: dict[str, Any]) -> bool:
    blob = " ".join(
        str(payload.get(key) or "")
        for key in ("tool_name", "content", "output", "result", "response", "args", "input", "arguments", "path")
    )
    return bool(_CREATE_EXECUTION_TOOL_RE.search(blob))
