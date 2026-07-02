"""Agent Mode AG-UI SSE run endpoint."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.cursor_agent import cursor_agent_service, load_cursor_api_env
from api.cursor_to_agui import encode_sse, run_error, stream_cursor_as_agui
from api.ai_research_routes import get_ai_research_store
from control_plane.agent_thread_state import sync_focus_from_actions, sync_focus_from_registry, update_focus_from_tool
from control_plane.engine_registry import EngineRegistry

router = APIRouter(prefix="/api/control/agent/agui", tags=["agent-agui"])


class AgentAguiRunRequest(BaseModel):
    thread_id: str = Field(..., min_length=1, max_length=128)
    prompt: str = Field(..., min_length=1, max_length=20000)
    agent_id: Optional[str] = Field(default=None, max_length=256)
    interaction_mode: str = Field(default="ask")
    web_search_enabled: bool = True
    broker: Optional[str] = Field(default=None, max_length=32)
    account_env: Optional[str] = Field(default=None, max_length=32)


def _require_agent_thread(thread_id: str) -> dict[str, Any]:
    from api.agent_routes import _require_agent_thread as require_thread

    return require_thread(get_ai_research_store(), thread_id)


@router.post("/run", operation_id="agent_agui_run", summary="Run agent with AG-UI SSE stream")
async def agent_agui_run(req: AgentAguiRunRequest, request: Request):
    load_cursor_api_env()
    thread_id = req.thread_id.strip()

    from control_plane.agent_trade_completion import on_user_message_for_thread

    await on_user_message_for_thread(thread_id)

    session = _require_agent_thread(thread_id)

    mode = req.interaction_mode.strip().lower()
    if mode not in {"ask", "execute"}:
        mode = "ask"

    store = get_ai_research_store()
    metadata = dict(session.get("metadata") or {})
    metadata_changed = False
    if req.broker:
        broker = req.broker.strip().lower()
        if broker in {"angel", "etoro"} and metadata.get("broker") != broker:
            metadata["broker"] = broker
            metadata_changed = True
    if req.account_env:
        env = req.account_env.strip().lower()
        if env in {"live", "demo"} and metadata.get("account_env") != env:
            metadata["account_env"] = env
            metadata_changed = True
    if metadata_changed:
        store.update_session(thread_id, {"metadata": metadata})
        session = store.get_session(thread_id) or session

    agent_id = req.agent_id.strip() if req.agent_id else None
    if not agent_id and session.get("cursor_agent_id"):
        agent_id = session.get("cursor_agent_id")

    cancel_event = asyncio.Event()
    active_run: dict[str, Any] = {"run": None}

    async def cursor_events():
        async for event in cursor_agent_service.stream_chat(
            prompt=req.prompt,
            agent_id=agent_id,
            interaction_mode=mode,
            web_search_enabled=req.web_search_enabled,
            research_session_id=thread_id,
            ws=None,
            cancel_event=cancel_event,
            active_run=active_run,
        ):
            if event.get("type") == "tool_call":
                detail = str(event.get("content") or event.get("path") or "")
                symbol = None
                execution_id = None
                if "symbol" in detail.lower():
                    import re

                    match = re.search(r'"symbol"\s*:\s*"([^"]+)"', detail)
                    if match:
                        symbol = match.group(1)
                path = str(event.get("path") or "")
                if "/executions/" in path:
                    import re

                    match = re.search(r"/executions/([^/]+)/", path)
                    if match:
                        execution_id = match.group(1)
                update_focus_from_tool(
                    thread_id,
                    tool_name=str(event.get("tool_name") or ""),
                    tool_detail=detail,
                    symbol=symbol,
                    execution_id=execution_id,
                )
            yield event

    def on_done() -> dict[str, Any] | None:
        from api.ai_research_routes import enrich_session_metadata

        store = get_ai_research_store()
        registry = EngineRegistry()
        store.sync_session_action_links(thread_id, registry)
        enrich_session_metadata(store, thread_id)
        session_row = store.get_session(thread_id)
        if not session_row:
            return None
        session_row = sync_focus_from_actions(session_row)
        return sync_focus_from_registry(session_row, registry)

    async def event_stream():
        try:
            async for chunk in stream_cursor_as_agui(
                cursor_events(),
                thread_id=thread_id,
                on_done=on_done,
            ):
                if await request.is_disconnected():
                    cancel_event.set()
                    break
                yield chunk
        except asyncio.CancelledError:
            run = active_run.get("run")
            if run is not None and getattr(run, "supports", lambda _: False)("cancel"):
                with contextlib.suppress(Exception):
                    await run.cancel()
            yield encode_sse(run_error("Stopped", thread_id, "stopped"))
        except Exception as exc:
            yield encode_sse(run_error(str(exc), thread_id, "error"))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/stop", operation_id="agent_agui_stop", summary="Stop in-flight AG-UI run")
async def agent_agui_stop(body: dict[str, Any]):
    # Placeholder — client disconnect cancels via request.is_disconnected in /run
    return {"status": True, "data": {"stopped": True}}
