"""Detect agent trade completion, log PnL, and stop background monitoring."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from api.fenced_json import iter_fenced_json_blocks
from control_plane.agent_thread_state import AGENT_PRODUCT, UI_PHASE_TRADING

log = logging.getLogger("backtrading")

TRADE_COMPLETE_TYPES = frozenset({"trade_complete", "trade_completed", "session_complete"})
EXIT_STRATEGY_TYPES = frozenset({"exit_strategy", "stop_strategy", "close_position"})


def extract_exit_actions(text: str) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for _, payload in iter_fenced_json_blocks(text):
        if not isinstance(payload, dict):
            continue
        action = payload.get("ai_action")
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("type") or "").lower()
        if action_type not in EXIT_STRATEGY_TYPES:
            continue
        body = dict(action.get("payload") or {})
        body["type"] = action_type
        body["title"] = action.get("title") or body.get("title")
        actions.append(body)
    return actions


async def execute_exit_actions(thread_id: str, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from control_plane.engine_process_manager import engine_process_manager
    from control_plane.engine_registry import EngineRegistry

    registry = EngineRegistry()
    results: list[dict[str, Any]] = []
    for payload in actions:
        execution_id = str(payload.get("execution_id") or "").strip()
        if not execution_id:
            from api.ai_research_routes import get_ai_research_store
            session = get_ai_research_store().get_session(thread_id) or {}
            focus = (session.get("metadata") or {}).get("focus") or {}
            execution_id = str(focus.get("execution_id") or "").strip()
        if not execution_id:
            continue
        engine = registry.get_engine(execution_id)
        if not engine:
            continue
        stopped = engine_process_manager.stop_engine(execution_id)
        if stopped:
            results.append({"execution_id": execution_id, "status": "stopped", "reason": payload.get("reason")})
            log.info(
                "[AGENT_MONITOR] auto-stopped execution=%s thread=%s reason=%s",
                execution_id,
                thread_id,
                payload.get("reason"),
            )
    return results


def extract_trade_completions(text: str) -> list[dict[str, Any]]:
    """Parse ai_action trade_complete blocks from assistant text."""
    completions: list[dict[str, Any]] = []
    for _, payload in iter_fenced_json_blocks(text):
        if not isinstance(payload, dict):
            continue
        action = payload.get("ai_action")
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("type") or "").lower()
        if action_type not in TRADE_COMPLETE_TYPES:
            continue
        body = dict(action.get("payload") or {})
        body["title"] = action.get("title") or body.get("title")
        body["type"] = action_type
        completions.append(body)
    return completions


def _normalize_outcome(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"profit", "win", "gain"}:
        return "profit"
    if text in {"loss", "lose", "losing"}:
        return "loss"
    if text in {"breakeven", "flat", "even"}:
        return "breakeven"
    try:
        pnl = float(value)
        if pnl > 0:
            return "profit"
        if pnl < 0:
            return "loss"
    except (TypeError, ValueError):
        pass
    return text or "unknown"


def record_trade_log(thread_id: str, payload: dict[str, Any], *, source: str = "agent") -> dict[str, Any]:
    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    session = store.get_session(thread_id)
    focus = ((session or {}).get("metadata") or {}).get("focus") or {}

    pnl_raw = payload.get("pnl")
    try:
        pnl = float(pnl_raw) if pnl_raw is not None else None
    except (TypeError, ValueError):
        pnl = None

    pnl_pct_raw = payload.get("pnl_pct") or payload.get("pnl_percent")
    try:
        pnl_pct = float(pnl_pct_raw) if pnl_pct_raw is not None else None
    except (TypeError, ValueError):
        pnl_pct = None

    outcome = _normalize_outcome(payload.get("outcome") or pnl)

    row = {
        "id": str(uuid.uuid4()),
        "session_id": thread_id,
        "symbol": str(payload.get("symbol") or focus.get("symbol") or ""),
        "broker": str(payload.get("broker") or focus.get("broker") or ""),
        "account_env": str(payload.get("account_env") or focus.get("account_env") or ""),
        "outcome": outcome,
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "entry_price": payload.get("entry_price") or payload.get("open_rate") or focus.get("close_price"),
        "exit_price": payload.get("exit_price") or payload.get("close_price"),
        "capital": payload.get("capital") or payload.get("max_available_capital") or focus.get("max_available_capital"),
        "position_id": payload.get("position_id") or payload.get("positionId"),
        "execution_id": payload.get("execution_id") or focus.get("execution_id"),
        "notes": str(payload.get("reason") or payload.get("notes") or payload.get("title") or ""),
        "metadata": {
            "source": source,
            **{
                k: v for k, v in payload.items()
                if k not in {
                    "symbol", "broker", "account_env", "outcome", "pnl", "pnl_pct",
                    "entry_price", "exit_price", "capital", "position_id", "execution_id",
                }
            },
        },
    }
    store.insert_agent_trade_log(row)
    log.info(
        "[AGENT_TRADE] logged thread=%s symbol=%s pnl=%s outcome=%s",
        thread_id,
        row["symbol"],
        pnl,
        outcome,
    )
    return row


async def complete_agent_monitoring(thread_id: str, *, reason: str = "trade_complete") -> None:
    from control_plane.agent_monitor import get_agent_monitor_service

    service = get_agent_monitor_service()
    await service.complete_thread(thread_id, reason=reason)


def mark_monitor_completed(thread_id: str, *, reason: str = "trade_complete") -> dict[str, Any] | None:
    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    session = store.get_session(thread_id)
    if not session:
        return None
    metadata = dict(session.get("metadata") or {})
    metadata["monitor_state"] = "completed"
    metadata["monitor_active"] = False
    metadata["monitor_complete_reason"] = reason
    metadata["monitor_completed_at"] = time.time()
    return store.update_session(thread_id, {"metadata": metadata})


async def process_assistant_monitor_actions(thread_id: str, assistant_text: str) -> list[dict[str, Any]]:
    """Exit, enter, and complete trades declared by the autonomous monitor agent."""
    from control_plane.agent_autonomous_trade import (
        execute_autonomous_entries,
        extract_autonomous_entries,
    )

    exit_results = await execute_exit_actions(thread_id, extract_exit_actions(assistant_text))
    entry_results = await execute_autonomous_entries(thread_id, extract_autonomous_entries(assistant_text))
    completions = extract_trade_completions(assistant_text)
    if not completions and not exit_results and not entry_results:
        return []

    logged: list[dict[str, Any]] = []
    for payload in completions:
        logged.append(record_trade_log(thread_id, payload, source="agent"))
    if completions:
        await complete_agent_monitoring(thread_id, reason="trade_complete")
    return [*exit_results, *entry_results, *logged]


async def process_assistant_trade_completions(thread_id: str, assistant_text: str) -> list[dict[str, Any]]:
    """Log trade completions, auto-stop strategies on exit, and shut down monitoring."""
    return await process_assistant_monitor_actions(thread_id, assistant_text)


def log_position_close_for_execution(
    execution_id: str,
    *,
    position_id: str,
    position_row: dict[str, Any] | None = None,
    engine: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Log PnL when a position is closed via control plane (agent-linked executions)."""
    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    thread_id = store.find_research_session_for_execution(execution_id, engine)
    if not thread_id:
        return None

    session = store.get_session(thread_id)
    if not session or (session.get("metadata") or {}).get("product") != AGENT_PRODUCT:
        return None

    row = position_row or {}
    pnl = None
    nested = row.get("unrealizedPnL")
    if isinstance(nested, dict):
        pnl = nested.get("pnL")
    if pnl is None:
        pnl = row.get("pnl") or row.get("profit")

    try:
        pnl_f = float(pnl) if pnl is not None else None
    except (TypeError, ValueError):
        pnl_f = None

    symbol = row.get("tradingsymbol") or row.get("symbol")
    if not symbol and engine:
        symbol = engine.get("symbol")

    payload = {
        "symbol": symbol,
        "position_id": position_id,
        "execution_id": execution_id,
        "pnl": pnl_f,
        "outcome": _normalize_outcome(pnl_f),
        "entry_price": row.get("open_rate") or row.get("openRate"),
        "exit_price": row.get("ltp") or row.get("currentRate"),
        "reason": "Position closed via control plane",
    }
    logged = record_trade_log(thread_id, payload, source="position_close")

    import asyncio

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(complete_agent_monitoring(thread_id, reason="position_closed"))
    except RuntimeError:
        pass
    return logged


async def on_user_message_for_thread(thread_id: str) -> bool:
    """User sent a new message — resume monitoring if a prior trade cycle completed."""
    from api.ai_research_routes import get_ai_research_store
    from control_plane.agent_monitor import get_agent_monitor_service

    store = get_ai_research_store()
    session = store.get_session(thread_id)
    if not session or (session.get("metadata") or {}).get("product") != AGENT_PRODUCT:
        return False

    metadata = dict(session.get("metadata") or {})
    if metadata.get("monitor_state") != "completed":
        return False

    metadata["monitor_state"] = "active"
    metadata.pop("monitor_completed_at", None)
    metadata.pop("monitor_complete_reason", None)
    store.update_session(thread_id, {"metadata": metadata})

    focus = metadata.get("focus") or {}
    if metadata.get("ui_phase") == UI_PHASE_TRADING and focus.get("symbol"):
        await get_agent_monitor_service().start_thread(thread_id)
        return True
    return True
