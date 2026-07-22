"""Generate a TradingView screener definition from free-form user text via Cursor agent."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from api.fenced_json import iter_fenced_json_blocks
from control_plane.screener_fields import SCREENER_FIELDS
from control_plane.screener_query import ScreenerDefinition, ScreenerQueryError, definition_to_dsl

log = logging.getLogger("backtrading")

_ALLOWED_OPS = {
    "greater",
    "egreater",
    "less",
    "eless",
    "equal",
    "nequal",
    "in_range",
    "not_in_range",
    "match",
    "nmatch",
    "empty",
    "nempty",
    "has",
    "has_none_of",
}


def _field_catalog_text() -> str:
    lines = []
    for row in SCREENER_FIELDS:
        ops = ",".join(op["id"] for op in (row.get("ops") or [])[:8])
        lines.append(f"- {row['key']} ({row['label']}, {row['type']}) ops=[{ops}]")
    return "\n".join(lines)


def build_screener_generate_prompt(user_text: str) -> str:
    catalog = _field_catalog_text()
    return f"""You are a TradingView stock screener builder for US equities (market=america).

Convert the user's request into ONE screener definition using ONLY the field keys listed below.

Allowed fields:
{catalog}

Filter operations (use exact ids): greater, egreater, less, eless, equal, nequal, in_range, not_in_range, match, nmatch, empty, nempty, has, has_none_of.
- Percent fields like change / premarket_change use percent units (5 means 5%, not 0.05).
- Volume / market_cap_basic are absolute numbers.
- Prefer 4–10 useful columns including name, close, change, volume when relevant.
- Default limit 50, order_by the most relevant metric descending.
- Optional indexes for liquid names only: ["SYML:SP;SPX", "SYML:NASDAQ;NDX"]
- Prefer flat filters[]; use filter_group only for OR sector/industry groups.

User request:
{user_text.strip()}

Respond with EXACTLY one fenced JSON block and nothing else after it:
```json
{{
  "name": "Short screener title",
  "explanation": "One sentence of what this screens for",
  "definition": {{
    "columns": ["name", "close", "change", "volume"],
    "filters": [{{"left": "change", "operation": "greater", "right": 3}}],
    "filter_group": null,
    "order_by": "change",
    "ascending": false,
    "limit": 50,
    "offset": 0,
    "market": "america",
    "indexes": []
  }}
}}
```
"""


def parse_screener_generate_payload(assistant_text: str) -> dict[str, Any] | None:
    """Extract {name, definition, explanation?} from agent text."""
    text = assistant_text or ""
    for _fence, payload in iter_fenced_json_blocks(text):
        if isinstance(payload.get("definition"), dict):
            return payload
        # Sometimes the whole object IS the definition
        if isinstance(payload.get("columns"), list) and isinstance(payload.get("filters"), list):
            return {"name": "AI screener", "definition": payload, "explanation": ""}

    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            if isinstance(payload.get("definition"), dict):
                return payload
            if isinstance(payload.get("columns"), list):
                return {"name": "AI screener", "definition": payload, "explanation": ""}
    return None


def _sanitize_definition_dict(raw: dict[str, Any]) -> dict[str, Any]:
    data = dict(raw or {})
    filters = []
    for item in data.get("filters") or []:
        if not isinstance(item, dict):
            continue
        left = str(item.get("left") or "").strip()
        operation = str(item.get("operation") or "").strip()
        if not left or operation not in _ALLOWED_OPS:
            continue
        filters.append({
            "left": left,
            "operation": operation,
            "right": item.get("right"),
        })
    data["filters"] = filters
    if not data.get("columns"):
        data["columns"] = ["name", "close", "change", "volume", "market_cap_basic"]
    data.setdefault("market", "america")
    data.setdefault("limit", 50)
    data.setdefault("ascending", False)
    data.setdefault("offset", 0)
    if "indexes" not in data:
        data["indexes"] = []
    return data


async def generate_screener_from_text(
    prompt: str,
    *,
    model_id: str | None = None,
    model_params: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Run Cursor agent and return validated name + ScreenerDefinition dict + dsl."""
    user_text = (prompt or "").strip()
    if not user_text:
        raise ValueError("prompt is required")

    from api.cursor_sdk_bridge import (
        CURSOR_CONFIG_HINT,
        cursor_sdk_bridge,
        load_cursor_api_env,
    )

    # Same as /api/control/cursor-agent/* — key lives in .cursor-api.env.
    load_cursor_api_env()
    if not cursor_sdk_bridge.configured:
        raise RuntimeError(CURSOR_CONFIG_HINT)

    # Screener generation is a pure JSON transform — do NOT route through Strategy AI
    # stream_chat (MCP + ask/execute wrappers). Those caused intermittent
    # "Cursor agent run failed" right after MCP ListTools handshake.
    agent_prompt = build_screener_generate_prompt(user_text)
    text_parts: list[str] = []
    assistant_text = ""
    cleaned_params: list[dict[str, str]] | None = None
    if model_params:
        cleaned_params = [
            {"id": str(p.get("id") or "").strip(), "value": str(p.get("value") or "").strip()}
            for p in model_params
            if isinstance(p, dict) and str(p.get("id") or "").strip() and str(p.get("value") or "").strip()
        ] or None

    last_error = "Cursor agent error"
    async for event in cursor_sdk_bridge.stream_run(
        session_name="screener-ai",
        prompt=agent_prompt,
        agent_id=None,
        mcp_servers=None,
        model_id=(model_id or "").strip() or None,
        model_params=cleaned_params,
    ):
        et = event.get("type")
        if et == "error":
            last_error = str(event.get("message") or last_error)
            raise RuntimeError(last_error)
        if et == "text_delta":
            text_parts.append(str(event.get("text") or ""))
        if et == "done":
            assistant_text = str(event.get("text") or "") or "".join(text_parts)

    if not assistant_text.strip():
        assistant_text = "".join(text_parts)

    parsed = parse_screener_generate_payload(assistant_text)
    if not parsed:
        log.warning("[SCREENER_AI] failed to parse agent output: %s", assistant_text[:800])
        raise ValueError("AI did not return a valid screener definition — try rephrasing")

    name = str(parsed.get("name") or "AI screener").strip()[:80] or "AI screener"
    explanation = str(parsed.get("explanation") or "").strip()
    raw_def = parsed.get("definition") if isinstance(parsed.get("definition"), dict) else {}
    sanitized = _sanitize_definition_dict(raw_def)
    try:
        defn = ScreenerDefinition.from_dict(sanitized)
    except ScreenerQueryError as exc:
        raise ValueError(f"AI returned an invalid screener: {exc}") from exc

    return {
        "name": name,
        "explanation": explanation,
        "definition": defn.to_dict(),
        "dsl_text": definition_to_dsl(defn),
    }
