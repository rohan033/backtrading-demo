from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.ai_research_routes import get_ai_research_store, strip_ai_action_blocks, strip_ai_summary_blocks
from control_plane.ai_research_store import AiResearchStore
from control_plane.agent_thread_state import sync_focus_from_actions, sync_focus_from_registry
from control_plane.engine_registry import EngineRegistry

router = APIRouter(prefix="/api/control/agent", tags=["agent"])

AGENT_PRODUCT = "agent_mode"


def _is_agent_thread(session: dict[str, Any]) -> bool:
    metadata = session.get("metadata") or {}
    return metadata.get("product") == AGENT_PRODUCT


def _require_agent_thread(store: AiResearchStore, thread_id: str) -> dict[str, Any]:
    session = store.get_session(thread_id)
    if not session or not _is_agent_thread(session):
        raise HTTPException(status_code=404, detail="Agent thread not found")
    return session


def _thread_view(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "thread_id": session["session_id"],
        "title": session["title"],
        "status": session.get("status") or "active",
        "summary": session.get("summary"),
        "actions": session.get("actions") or [],
        "metadata": session.get("metadata") or {},
        "cursor_agent_id": session.get("cursor_agent_id"),
        "created_at": session.get("created_at"),
        "updated_at": session.get("updated_at"),
        "last_message_at": session.get("last_message_at"),
    }


class CreateThreadRequest(BaseModel):
    title: str = Field(default="New thread", max_length=200)


class UpdateThreadRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    summary: Optional[str] = None
    status: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


@router.get("/threads", operation_id="list_agent_threads", summary="List agent mode threads")
def list_agent_threads(limit: int = 100):
    store = get_ai_research_store()
    sessions = store.list_sessions(limit=limit)
    threads = [_thread_view(session) for session in sessions if _is_agent_thread(session)]
    return {"status": True, "data": threads}


@router.post("/threads", operation_id="create_agent_thread", summary="Create an agent mode thread")
def create_agent_thread(req: CreateThreadRequest):
    store = get_ai_research_store()
    session = store.create_session(
        title=req.title.strip() or "New thread",
        interaction_mode="ask",
        metadata={"product": AGENT_PRODUCT, "ui_phase": "chat"},
    )
    return {"status": True, "data": _thread_view(session)}


@router.get("/threads/{thread_id}", operation_id="get_agent_thread", summary="Get one agent thread")
def get_agent_thread(thread_id: str):
    store = get_ai_research_store()
    _require_agent_thread(store, thread_id)
    store.sync_session_action_links(thread_id, EngineRegistry())
    session = store.get_session(thread_id)
    if session:
        registry = EngineRegistry()
        session = sync_focus_from_actions(session)
        session = sync_focus_from_registry(session, registry)
    return {"status": True, "data": _thread_view(session or {})}


@router.patch("/threads/{thread_id}", operation_id="update_agent_thread", summary="Update an agent thread")
def update_agent_thread(thread_id: str, req: UpdateThreadRequest):
    store = get_ai_research_store()
    session = _require_agent_thread(store, thread_id)
    payload = req.model_dump(exclude_none=True)
    if "metadata" in payload and isinstance(payload["metadata"], dict):
        merged = dict(session.get("metadata") or {})
        merged.update(payload["metadata"])
        payload["metadata"] = merged
    session = store.update_session(thread_id, payload)
    if not session:
        raise HTTPException(status_code=404, detail="Agent thread not found")
    return {"status": True, "data": _thread_view(session)}


@router.get("/threads/{thread_id}/messages", operation_id="list_agent_thread_messages", summary="List agent thread messages")
def list_agent_thread_messages(thread_id: str, limit: int = 50, before: Optional[str] = None):
    store = get_ai_research_store()
    _require_agent_thread(store, thread_id)
    page = store.list_messages(thread_id, limit=limit, before=before)
    for message in page["messages"]:
        if message.get("role") == "assistant" and message.get("content"):
            message["content"] = strip_ai_action_blocks(strip_ai_summary_blocks(message["content"]))
    return {"status": True, "data": page}
