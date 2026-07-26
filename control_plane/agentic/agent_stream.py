"""Cursor agent streaming for agentic sessions — plain-text summaries only, no A2UI."""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from control_plane.trading_session_agent_common import (
    clear_session_agent_run,
    register_session_agent_run,
    session_event_from_cursor,
)

log = logging.getLogger("backtrading")


async def stream_agentic_prompt(
    *,
    session_id: str,
    store: Any,
    state: str,
    prompt: str,
    interaction_mode: str = "analyze",
    web_search_enabled: bool = False,
) -> str:
    """Run Cursor agent and append one-line thinking events via the agentic store adapter."""
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

    session = store.get_session(session_id) or {}
    config = session.get("config") if isinstance(session.get("config"), dict) else {}
    model_id = (
        str(session.get("agent_model") or config.get("agent_model") or "").strip() or None
    )
    raw_params = session.get("agent_model_params")
    if raw_params is None:
        raw_params = config.get("agent_model_params")
    model_params = raw_params if isinstance(raw_params, list) else None

    try:
        async for event in cursor_agent_service.stream_chat(
            prompt=prompt,
            agent_id=None,
            interaction_mode=interaction_mode,
            web_search_enabled=web_search_enabled,
            trading_session=False,
            agentic_session=True,
            trading_session_id=session_id,
            cancel_event=cancel_event,
            active_run=active_run,
            model_id=model_id,
            model_params=model_params,
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
