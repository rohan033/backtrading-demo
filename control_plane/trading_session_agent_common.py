"""Shared Cursor agent streaming and A2UI helpers for trading session phases."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any, Callable

from api.control_plane_mcp_tools import (
    is_mutation_mcp_tool_name,
    is_read_mcp_tool_name,
    normalize_mcp_tool_name,
)
from api.cursor_agent import REPO_READ_TOOL_NAMES, WEB_SEARCH_TOOL_NAMES
from api.a2ui_bridge import expand_agent_text_to_surfaces, tool_log_surface
from api.ai_research_routes import extract_actions_from_assistant_text

log = logging.getLogger("backtrading")

_phase_tasks: dict[str, asyncio.Task] = {}
_phase_locks: dict[str, asyncio.Lock] = {}

_active_session_runs: dict[str, dict[str, Any]] = {}


def register_session_agent_run(
    session_id: str,
    *,
    cancel_event: asyncio.Event,
    active_run: dict[str, Any],
    run_id: str,
    state: str,
) -> None:
    _active_session_runs[session_id] = {
        "cancel_event": cancel_event,
        "active_run": active_run,
        "run_id": run_id,
        "state": state,
    }


def clear_session_agent_run(session_id: str) -> None:
    _active_session_runs.pop(session_id, None)


async def cancel_session_agent_run(session_id: str) -> None:
    entry = _active_session_runs.pop(session_id, None)
    if not entry:
        return
    cancel_event = entry.get("cancel_event")
    if cancel_event is not None:
        cancel_event.set()
    active_run = entry.get("active_run") or {}
    run = active_run.get("run")
    if run is not None:
        with contextlib.suppress(Exception):
            if hasattr(run, "supports") and run.supports("cancel"):
                await run.cancel()


def classify_tool_source(tool_name: str) -> str:
    normalized = normalize_mcp_tool_name(tool_name)
    if normalized in WEB_SEARCH_TOOL_NAMES:
        return "web"
    if is_read_mcp_tool_name(tool_name) or is_mutation_mcp_tool_name(tool_name):
        return "mcp"
    if normalized in REPO_READ_TOOL_NAMES:
        return "repo"
    return "tool"


def session_event_from_cursor(
    state: str,
    event: dict[str, Any],
    run_id: str,
) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    event_type = event.get("type")

    if event_type == "start":
        out.append(("agent_run_started", {"state": state, "run_id": run_id}))
        return out

    if event_type == "tool_call":
        tool_log = tool_log_surface(event)
        if tool_log:
            props = tool_log.get("props") or {}
            raw_name = str(
                props.get("toolName") or props.get("tool_name") or event.get("tool_name") or "tool"
            )
            out.append((
                "agent_tool_call",
                {
                    "tool_name": raw_name,
                    "tool_source": classify_tool_source(raw_name),
                    "tool_status": props.get("status") or event.get("tool_status"),
                    "detail": props.get("detail") or "",
                    "run_id": run_id,
                },
            ))
        return out

    if event_type == "text_delta":
        chunk = str(event.get("text") or "")
        if chunk:
            out.append(("agent_thinking", {"message": chunk, "run_id": run_id}))
        return out

    if event_type == "done":
        full_text = str(event.get("text") or "")
        if full_text:
            out.append(("agent_text", {"text": full_text, "role": "assistant", "run_id": run_id}))
        out.append(("agent_run_finished", {"state": state, "run_id": run_id, "ok": True}))
        return out

    if event_type == "error":
        out.append((
            "agent_run_finished",
            {"state": state, "run_id": run_id, "ok": False, "error": event.get("message")},
        ))
        return out

    message_type = event.get("message_type")
    if message_type == "status":
        msg = str(event.get("message") or event.get("status") or "").strip()
        if msg:
            out.append(("agent_thinking", {"message": msg, "run_id": run_id}))
    return out


async def stream_agent_prompt(
    *,
    session_id: str,
    store: Any,
    state: str,
    prompt: str,
    interaction_mode: str = "execute",
    web_search_enabled: bool = True,
) -> str:
    """Run Cursor agent, append session events, return full assistant text."""
    from api.cursor_agent import cursor_agent_service

    run_id = str(uuid.uuid4())
    text_parts: list[str] = []
    assistant_text = ""
    cancel_event = asyncio.Event()
    active_run: dict[str, Any] = {"run": None}
    register_session_agent_run(
        session_id,
        cancel_event=cancel_event,
        active_run=active_run,
        run_id=run_id,
        state=state,
    )

    try:
        async for event in cursor_agent_service.stream_chat(
            prompt=prompt,
            agent_id=None,
            interaction_mode=interaction_mode,
            web_search_enabled=web_search_enabled,
            trading_session=True,
            cancel_event=cancel_event,
            active_run=active_run,
        ):
            current = store.get_session(session_id)
            if not current or current.get("state") == "stopped":
                break
            for event_type, payload in session_event_from_cursor(state, event, run_id):
                store.append_event(session_id, event_type, payload)
            if event.get("type") == "text_delta":
                text_parts.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                assistant_text = str(event.get("text") or "") or "".join(text_parts)
    except asyncio.CancelledError:
        store.append_event(
            session_id,
            "agent_run_finished",
            {"state": state, "run_id": run_id, "ok": False, "error": "Cancelled"},
        )
        raise
    finally:
        clear_session_agent_run(session_id)

    return assistant_text


def emit_surfaces_from_text(store: Any, session_id: str, assistant_text: str) -> None:
    for surface in expand_agent_text_to_surfaces(assistant_text):
        store.append_event(session_id, "agent_a2ui_surface", surface)


def parse_strategy_suggestion(assistant_text: str) -> dict[str, Any] | None:
    for action in extract_actions_from_assistant_text(assistant_text):
        action_type = str(action.get("type") or "").lower()
        if action_type in {"strategy_suggestion", "strategy"}:
            body = dict(action.get("payload") or {})
            for key in ("symbol", "token", "exchange", "broker", "account_env"):
                if action.get(key) is not None and body.get(key) is None:
                    body[key] = action.get(key)
            return body
    return None


def schedule_phase_task(
    key: str,
    coro_factory: Callable[[], Any],
) -> None:
    existing = _phase_tasks.get(key)
    if existing and not existing.done():
        return

    async def _wrapper() -> None:
        lock = _phase_locks.setdefault(key, asyncio.Lock())
        async with lock:
            await coro_factory()

    try:
        loop = asyncio.get_running_loop()
        _phase_tasks[key] = loop.create_task(_wrapper())
    except RuntimeError:
        log.warning("[TRADING_SESSION] no event loop to schedule task %s", key)


def cancel_phase_task(key: str, *, skip_current: bool = False) -> None:
    task = _phase_tasks.get(key)
    if not task or task.done():
        _phase_tasks.pop(key, None)
        return
    if skip_current:
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if task is current:
            return
    _phase_tasks.pop(key, None)
    task.cancel()


def cancel_all_session_tasks(session_id: str, *, skip_current: bool = False) -> None:
    for prefix in ("explore", "research", "strategy", "monitor"):
        cancel_phase_task(f"{session_id}:{prefix}", skip_current=skip_current)
