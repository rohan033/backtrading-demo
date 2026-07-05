"""Expand minimal agent a2ui fences into A2UI surface payloads for the client catalog."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Iterator

from api.fenced_json import iter_fenced_json_blocks

ALLOWED_COMPONENTS = frozenset({
    "Text",
    "Heading",
    "BulletList",
    "TradeDecision",
    "ToolStatus",
    "StrategySummary",
    "StrategySetupForm",
    "InsightCards",
    "ButtonRow",
    "TopStockPicks",
    "CandidateDebate",
})

_GENERIC_THREAD_TITLES = frozenset({"", "New research", "New thread", "Thread 1"})


def a2ui_block_from_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    block = payload.get("a2ui")
    if isinstance(block, dict) and block.get("component") in ALLOWED_COMPONENTS:
        return block
    component = payload.get("component")
    if component in ALLOWED_COMPONENTS:
        return {
            "component": component,
            "props": dict(payload.get("props") or {}),
        }
    return None


def is_recognized_fence_payload(payload: dict[str, Any]) -> bool:
    if a2ui_block_from_payload(payload) is not None:
        return True
    if isinstance(payload.get("ai_action"), dict):
        return True
    if isinstance(payload.get("ai_summary"), dict):
        return True
    return False


def extract_a2ui_blocks(text: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for _, payload in iter_fenced_json_blocks(text):
        block = a2ui_block_from_payload(payload)
        if block is not None:
            blocks.append(block)
    return blocks


def strip_recognized_fences(text: str) -> str:
    cleaned = text
    for full_match, payload in iter_fenced_json_blocks(text):
        if is_recognized_fence_payload(payload):
            cleaned = cleaned.replace(full_match, "", 1)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def strip_a2ui_blocks(text: str) -> str:
    return strip_recognized_fences(text)


def collapse_markdown_prose(text: str, *, max_len: int = 120) -> str:
    """Strip markdown and collapse whitespace for minimal Text fallback."""
    cleaned = text.strip()
    if not cleaned:
        return ""
    cleaned = strip_recognized_fences(cleaned)
    cleaned = re.sub(r"```[\s\S]*?```", "", cleaned)
    cleaned = re.sub(r"^#{1,6}\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"^[-*]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"(?is)\n?\**sources?\**\s*:.*$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > max_len:
        return cleaned[: max_len - 1].rstrip() + "…"
    return cleaned


def _surface_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def component_to_surface(
    component: str,
    props: dict[str, Any],
    *,
    role: str = "agent",
    message_id: str | None = None,
) -> dict[str, Any]:
    """Client-friendly A2UI surface update (simplified v1)."""
    mid = message_id or _surface_id("msg")
    root_id = _surface_id("root")
    return {
        "type": "a2ui_surface",
        "messageId": mid,
        "role": role,
        "components": [
            {
                "id": root_id,
                "component": component,
                "props": props,
            },
        ],
    }


def text_surface(text: str, *, role: str = "agent", message_id: str | None = None) -> dict[str, Any]:
    trimmed = collapse_markdown_prose(text)
    if not trimmed:
        return component_to_surface("Text", {"text": ""}, role=role, message_id=message_id)
    return component_to_surface("Text", {"text": trimmed}, role=role, message_id=message_id)


def strategy_setup_surface(action: dict[str, Any], *, message_id: str | None = None) -> dict[str, Any]:
    payload = action.get("payload") or action.get("strategy") or {}
    props: dict[str, Any] = {
        "title": action.get("title") or "Strategy setup",
        "actionId": action.get("id"),
        "status": action.get("status") or "open",
    }
    for key in (
        "symbol",
        "token",
        "exchange",
        "broker",
        "account_env",
        "close_price",
        "long_percent",
        "short_percent",
        "initial_threshold",
        "max_available_capital",
    ):
        if payload.get(key) is not None:
            props[key] = payload.get(key)
    return component_to_surface("StrategySetupForm", props, message_id=message_id)


def strategy_summary_surface(
    *,
    symbol: str,
    execution_id: str,
    entry_price: float | None = None,
    status: str = "running",
    broker: str | None = None,
    account_env: str | None = None,
    long_percent: float | None = None,
    short_percent: float | None = None,
    capital: float | None = None,
    confidence_pct: float | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    props: dict[str, Any] = {
        "symbol": symbol,
        "execution_id": execution_id,
        "status": status,
    }
    if entry_price is not None:
        props["entry_price"] = entry_price
    if broker:
        props["broker"] = broker
    if account_env:
        props["account_env"] = account_env
    if long_percent is not None:
        props["long_percent"] = long_percent
    if short_percent is not None:
        props["short_percent"] = short_percent
    if capital is not None:
        props["capital"] = capital
    if confidence_pct is not None:
        props["confidence_pct"] = confidence_pct
    return component_to_surface("StrategySummary", props, message_id=message_id)


def insight_cards_surface(summary: dict[str, list[str]], *, message_id: str | None = None) -> dict[str, Any]:
    return component_to_surface(
        "InsightCards",
        {
            "highlights": summary.get("highlights") or [],
            "lowlights": summary.get("lowlights") or [],
            "cautions": summary.get("cautions") or [],
        },
        message_id=message_id,
    )


def tool_status_surface(
    tool_name: str,
    status: str,
    detail: str | None = None,
) -> dict[str, Any]:
    return component_to_surface(
        "ToolStatus",
        {
            "toolName": tool_name,
            "status": status,
            "detail": detail or "",
        },
    )


def trade_decision_surface(text: str, symbol: str | None = None) -> dict[str, Any]:
    props: dict[str, Any] = {"text": collapse_markdown_prose(text, max_len=200)}
    if symbol:
        props["symbol"] = symbol
    return component_to_surface("TradeDecision", props)


def expand_text_to_surfaces(text: str, *, role: str = "agent") -> Iterator[dict[str, Any]]:
    yield from expand_agent_text_to_surfaces(text, role=role)


def expand_agent_text_to_surfaces(text: str, *, role: str = "agent") -> Iterator[dict[str, Any]]:
    """Agent Mode: a2ui blocks + strategy forms + insight cards; minimal plain text."""
    from api.ai_research_routes import (
        extract_actions_from_assistant_text,
        extract_reply_summary,
        strip_ai_action_blocks,
        strip_ai_summary_blocks,
    )

    for block in extract_a2ui_blocks(text):
        component = str(block.get("component"))
        props = dict(block.get("props") or {})
        if component == "Text" and props.get("text"):
            props["text"] = collapse_markdown_prose(str(props["text"]))
        if component == "CandidateDebate" and props.get("text"):
            props["text"] = collapse_markdown_prose(str(props["text"]), max_len=200)
        if component == "TradeDecision" and props.get("text"):
            props["text"] = collapse_markdown_prose(str(props["text"]), max_len=200)
        yield component_to_surface(component, props, role=role)

    for action in extract_actions_from_assistant_text(text):
        action_type = str(action.get("type") or "").lower()
        if action_type in {"trade_complete", "trade_completed", "session_complete"}:
            payload = dict(action.get("payload") or action)
            symbol = str(payload.get("symbol") or "")
            pnl = payload.get("pnl")
            outcome = str(payload.get("outcome") or "")
            label = f"Trade closed — {outcome or 'done'}"
            if pnl is not None:
                label += f" · PnL {pnl}"
            yield trade_decision_surface(label, symbol or None)
            continue
        if action_type in {"strategy_suggestion", "strategy"} or action.get("payload"):
            yield strategy_setup_surface(action)

    summary = extract_reply_summary(text)
    if summary:
        yield insight_cards_surface(summary)

    plain = strip_a2ui_blocks(strip_ai_action_blocks(strip_ai_summary_blocks(text)))
    plain = collapse_markdown_prose(plain)
    if plain:
        yield text_surface(plain, role=role)


def derive_agent_thread_title_from_text(text: str, session: dict[str, Any] | None = None) -> str | None:
    """Short trader-facing title from agent A2UI / strategy blocks."""
    from api.ai_research_routes import extract_actions_from_assistant_text

    metadata = (session or {}).get("metadata") or {}
    broker = str(metadata.get("broker") or "").strip()
    broker_label = {"angel": "Angel", "etoro": "eToro"}.get(broker.lower(), broker)

    for block in extract_a2ui_blocks(text):
        if block.get("component") != "TradeDecision":
            continue
        props = block.get("props") or {}
        symbol = str(props.get("symbol") or "").strip()
        if symbol:
            root = symbol.split("-")[0].upper()
            return f"{root} · {broker_label}" if broker_label else root

    for action in extract_actions_from_assistant_text(text):
        payload = action.get("payload") or {}
        symbol = str(payload.get("symbol") or "").strip()
        if symbol:
            root = symbol.split("-")[0].upper()
            title = str(action.get("title") or root).strip()
            if len(title) > 48:
                title = title[:47].rstrip() + "…"
            return title

    for block in extract_a2ui_blocks(text):
        if block.get("component") != "TopStockPicks":
            continue
        props = block.get("props") or {}
        selected = str(props.get("selected") or "").strip()
        if selected:
            return f"{selected.split('-')[0].upper()} picks"

    return None


def should_refresh_agent_thread_title(session: dict[str, Any]) -> bool:
    title = str(session.get("title") or "").strip()
    if title in _GENERIC_THREAD_TITLES:
        return True
    return title.endswith("…")


def surface_from_tool_call(event: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = str(event.get("tool_name") or "tool")
    status = str(event.get("tool_status") or "running")
    detail = _tool_detail(event)
    return tool_status_surface(tool_name, status, detail)


def tool_log_surface(event: dict[str, Any]) -> dict[str, Any] | None:
    surface = surface_from_tool_call(event)
    if not surface:
        return None
    return {**surface, "type": "a2ui_tool_log"}


def trade_decision_from_tool(event: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = str(event.get("tool_name") or "").lower()
    detail = _tool_detail(event)
    if tool_name == "search_instruments":
        return trade_decision_surface("Scanning instruments for the best setup.", None)
    if tool_name == "create_strategy":
        symbol = _symbol_from_detail(detail)
        label = f"Setting up strategy{f' on {symbol}' if symbol else ''}."
        return trade_decision_surface(label, symbol)
    if tool_name == "start_strategy":
        symbol = _symbol_from_detail(detail)
        label = f"Deploying live{f' on {symbol}' if symbol else ''}."
        return trade_decision_surface(label, symbol)
    return None


def _tool_detail(event: dict[str, Any]) -> str:
    for key in ("content", "args", "input", "arguments", "path", "command", "parameters"):
        value = event.get(key)
        if value:
            return str(value)
    return ""


def _symbol_from_detail(detail: str) -> str | None:
    match = re.search(r'"symbol"\s*:\s*"([^"]+)"', detail)
    if match:
        return match.group(1).split("-")[0]
    match = re.search(r"\b([A-Z]{2,6})(?:-EQ)?\b", detail.upper())
    if match:
        return match.group(1)
    return None


def monitor_batch_surface(
    *,
    run_id: str,
    symbol: str,
    event_count: int,
    kinds: list[str] | None = None,
    items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    unique_kinds = list(dict.fromkeys(kinds or []))
    return {
        "type": "a2ui_surface",
        "messageId": f"monitor-{run_id}",
        "role": "agent",
        "components": [{
            "id": f"monitor-{run_id}-root",
            "component": "MonitorBatch",
            "props": {
                "symbol": symbol,
                "eventCount": event_count,
                "kinds": unique_kinds,
                "items": items or [],
            },
        }],
    }
