"""Agent background monitor control endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.agent_monitor import get_agent_monitor_service

router = APIRouter(prefix="/api/control/agent/monitor", tags=["agent-monitor"])


class ClientMonitorFlushBody(BaseModel):
    context: dict[str, Any] = Field(default_factory=dict)
    instructions: str | None = None
    web_news_only: bool = False
    execution_decision: bool = False
    interaction_mode: str | None = None


@router.post(
    "/threads/{thread_id}/start",
    operation_id="start_agent_thread_monitor",
    summary="Start background monitor queue for an agent thread",
)
async def start_agent_thread_monitor(thread_id: str):
    service = get_agent_monitor_service()
    try:
        status = await service.start_thread(thread_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": True, "data": status}


@router.post(
    "/threads/{thread_id}/stop",
    operation_id="stop_agent_thread_monitor",
    summary="Stop background monitor for an agent thread",
)
async def stop_agent_thread_monitor(thread_id: str):
    service = get_agent_monitor_service()
    status = await service.stop_thread(thread_id.strip())
    return {"status": True, "data": status}


@router.get(
    "/threads/{thread_id}/status",
    operation_id="get_agent_thread_monitor_status",
    summary="Monitor queue status for an agent thread",
)
async def get_agent_thread_monitor_status(thread_id: str):
    service = get_agent_monitor_service()
    return {"status": True, "data": service.status(thread_id.strip())}


@router.post(
    "/threads/{thread_id}/flush-client",
    operation_id="flush_agent_thread_client_monitor",
    summary="Flush client-consolidated monitor context to the agent",
)
async def flush_agent_thread_client_monitor(thread_id: str, body: ClientMonitorFlushBody):
    service = get_agent_monitor_service()
    instructions = body.instructions
    if body.web_news_only and not instructions:
        from control_plane.agent_monitor import CLIENT_MONITOR_WEB_NEWS_INSTRUCTIONS

        instructions = CLIENT_MONITOR_WEB_NEWS_INSTRUCTIONS
    elif body.execution_decision and not instructions:
        from api.ai_research_routes import get_ai_research_store
        from control_plane.agent_monitor import monitor_instructions_for_mode

        store = get_ai_research_store()
        session = store.get_session(thread_id.strip()) or {}
        mode = str(body.interaction_mode or session.get("interaction_mode") or "ask")
        if body.interaction_mode and body.interaction_mode in {"ask", "execute"}:
            store.update_session(thread_id.strip(), {"interaction_mode": body.interaction_mode})
        instructions = monitor_instructions_for_mode(mode)
    try:
        status = await service.flush_client_context(
            thread_id.strip(),
            body.context,
            instructions=instructions,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": True, "data": status}
