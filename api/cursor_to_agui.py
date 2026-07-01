"""Map Cursor agent events to AG-UI-compatible SSE payloads + A2UI surfaces."""

from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator, Callable, Iterator

from api.a2ui_bridge import (
    expand_agent_text_to_surfaces,
    extract_a2ui_blocks,
    surface_from_tool_call,
    tool_log_surface,
    trade_decision_from_tool,
)


def _run_id() -> str:
    return str(uuid.uuid4())


def encode_sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def run_started(thread_id: str, run_id: str) -> dict[str, Any]:
    return {"type": "RUN_STARTED", "threadId": thread_id, "runId": run_id}


def run_finished(thread_id: str, run_id: str) -> dict[str, Any]:
    return {"type": "RUN_FINISHED", "threadId": thread_id, "runId": run_id}


def run_error(message: str, thread_id: str, run_id: str) -> dict[str, Any]:
    return {"type": "RUN_ERROR", "threadId": thread_id, "runId": run_id, "message": message}


def ui_phase_changed(phase: str, thread_id: str) -> dict[str, Any]:
    return {"type": "UI_PHASE_CHANGED", "threadId": thread_id, "uiPhase": phase}


def thread_updated(thread_id: str, session: dict[str, Any]) -> dict[str, Any]:
    metadata = session.get("metadata") or {}
    return {
        "type": "THREAD_UPDATED",
        "threadId": thread_id,
        "title": session.get("title"),
        "metadata": metadata,
        "uiPhase": metadata.get("ui_phase"),
    }


def cursor_event_to_agui(
    event: dict[str, Any],
    *,
    thread_id: str,
    run_id: str,
    text_buffer: list[str],
) -> Iterator[dict[str, Any]]:
    event_type = event.get("type")

    if event_type == "start":
        yield run_started(thread_id, run_id)
        return

    if event_type == "text_delta":
        chunk = str(event.get("text") or "")
        if chunk:
            text_buffer.append(chunk)
        return

    if event_type == "tool_call":
        tool_log = tool_log_surface(event)
        if tool_log:
            yield tool_log
        decision = trade_decision_from_tool(event)
        if decision:
            yield decision
        return

    if event_type == "done":
        full_text = str(event.get("text") or "")
        if not full_text and text_buffer:
            full_text = "".join(text_buffer)
        text_buffer.clear()

        for surface in expand_agent_text_to_surfaces(full_text, role="agent"):
            yield surface

        yield run_finished(thread_id, run_id)
        return

    if event_type == "error":
        yield run_error(str(event.get("message") or "Agent error"), thread_id, run_id)
        return

    if event_type == "stopped":
        yield run_finished(thread_id, run_id)
        return


async def stream_cursor_as_agui(
    cursor_events: AsyncIterator[dict[str, Any]],
    *,
    thread_id: str,
    on_done: Callable[[], dict[str, Any] | None] | None = None,
) -> AsyncIterator[str]:
    run_id = _run_id()
    text_buffer: list[str] = []
    prev_phase: str | None = None

    async for event in cursor_events:
        for agui_event in cursor_event_to_agui(
            event,
            thread_id=thread_id,
            run_id=run_id,
            text_buffer=text_buffer,
        ):
            yield encode_sse(agui_event)

        if event.get("type") == "done" and on_done:
            session = on_done()
            if session:
                yield encode_sse(thread_updated(thread_id, session))
                metadata = session.get("metadata") or {}
                phase = metadata.get("ui_phase")
                if phase and phase != prev_phase:
                    prev_phase = phase
                    yield encode_sse(ui_phase_changed(str(phase), thread_id))

        if event.get("type") in {"done", "error", "stopped"}:
            break
