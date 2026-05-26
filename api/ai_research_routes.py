from __future__ import annotations

import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from control_plane.ai_research_store import AiResearchStore

router = APIRouter(prefix="/api/control/ai-research", tags=["ai-research"])

_store: AiResearchStore | None = None


def get_ai_research_store() -> AiResearchStore:
    global _store
    if _store is None:
        _store = AiResearchStore()
    return _store


class CreateSessionRequest(BaseModel):
    title: str = "New research"
    interaction_mode: str = "ask"
    metadata: Optional[dict[str, Any]] = None


class UpdateSessionRequest(BaseModel):
    title: Optional[str] = None
    interaction_mode: Optional[str] = None
    status: Optional[str] = None
    summary: Optional[str] = None
    cursor_agent_id: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class UpsertActionRequest(BaseModel):
    id: Optional[str] = None
    type: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=500)
    status: str = "open"
    payload: dict[str, Any] = Field(default_factory=dict)
    sources: list[Any] = Field(default_factory=list)
    message_id: Optional[str] = None


class AppendMessageRequest(BaseModel):
    role: str
    content: str
    run_id: Optional[str] = None
    tool_name: Optional[str] = None
    tool_status: Optional[str] = None
    tool_detail: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    id: Optional[str] = None


@router.get("/sessions")
def list_research_sessions(status: Optional[str] = None, limit: int = 100):
    sessions = get_ai_research_store().list_sessions(status=status, limit=limit)
    return {"status": True, "data": sessions}


@router.post("/sessions")
def create_research_session(req: CreateSessionRequest):
    session = get_ai_research_store().create_session(
        title=req.title,
        interaction_mode=req.interaction_mode,
        metadata=req.metadata,
    )
    return {"status": True, "data": session}


@router.get("/sessions/{session_id}")
def get_research_session(session_id: str):
    store = get_ai_research_store()
    enrich_session_metadata(store, session_id)
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Research session not found")
    return {"status": True, "data": session}


@router.patch("/sessions/{session_id}")
def update_research_session(session_id: str, req: UpdateSessionRequest):
    payload = req.model_dump(exclude_none=True)
    session = get_ai_research_store().update_session(session_id, payload)
    if not session:
        raise HTTPException(status_code=404, detail="Research session not found")
    return {"status": True, "data": session}


@router.get("/sessions/{session_id}/messages")
def list_research_messages(session_id: str, limit: int = 50, before: Optional[str] = None):
    if not get_ai_research_store().get_session(session_id):
        raise HTTPException(status_code=404, detail="Research session not found")
    page = get_ai_research_store().list_messages(session_id, limit=limit, before=before)
    for message in page["messages"]:
        if message.get("role") == "assistant" and message.get("content"):
            message["content"] = strip_ai_action_blocks(message["content"])
    return {"status": True, "data": page}


@router.post("/sessions/{session_id}/messages")
def append_research_message(session_id: str, req: AppendMessageRequest):
    message = get_ai_research_store().append_message(
        session_id,
        role=req.role,
        content=req.content,
        run_id=req.run_id,
        tool_name=req.tool_name,
        tool_status=req.tool_status,
        tool_detail=req.tool_detail,
        metadata=req.metadata,
        message_id=req.id,
    )
    if not message:
        raise HTTPException(status_code=404, detail="Research session not found")
    return {"status": True, "data": message}


@router.post("/sessions/{session_id}/actions")
def upsert_research_action(session_id: str, req: UpsertActionRequest):
    session = get_ai_research_store().upsert_action(
        session_id,
        req.model_dump(exclude_none=True),
    )
    if not session:
        raise HTTPException(status_code=404, detail="Research session not found")
    return {"status": True, "data": session}


@router.delete("/sessions/{session_id}/actions/{action_id}")
def delete_research_action(session_id: str, action_id: str):
    session = get_ai_research_store().delete_action(session_id, action_id)
    if not session:
        raise HTTPException(status_code=404, detail="Research session not found")
    return {"status": True, "data": session}


_AI_ACTION_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", re.IGNORECASE)


def derive_session_title(text: str, *, max_len: int = 72) -> str:
    cleaned = " ".join(text.strip().split())
    if not cleaned:
        return "New research"
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 1].rstrip() + "…"


def derive_research_summary(text: str, *, max_len: int = 320) -> str:
    cleaned = strip_ai_action_blocks(text.strip())
    if not cleaned:
        return ""
    paragraph = cleaned.split("\n\n")[0].replace("\n", " ").strip()
    if not paragraph:
        paragraph = cleaned.replace("\n", " ").strip()
    if len(paragraph) <= max_len:
        return paragraph
    return paragraph[: max_len - 1].rstrip() + "…"


def enrich_session_metadata(store: AiResearchStore, session_id: str) -> None:
    session = store.get_session(session_id)
    if not session:
        return

    patch: dict[str, Any] = {}
    if session.get("title") in (None, "", "New research"):
        conn = store._connect()
        row = conn.execute(
            """
            SELECT content FROM ai_research_messages
            WHERE session_id = ? AND role = 'user'
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        conn.close()
        if row and row["content"]:
            patch["title"] = derive_session_title(row["content"])

    if not session.get("summary"):
        conn = store._connect()
        row = conn.execute(
            """
            SELECT content FROM ai_research_messages
            WHERE session_id = ? AND role = 'assistant'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        conn.close()
        if row and row["content"]:
            summary = derive_research_summary(row["content"])
            if summary:
                patch["summary"] = summary

    if patch:
        store.update_session(session_id, patch)


def _json_contains_ai_action(text: str) -> bool:
    import json

    try:
        payload = json.loads(text.strip())
    except json.JSONDecodeError:
        return False
    return isinstance(payload, dict) and bool(payload.get("ai_action"))


def strip_ai_action_blocks(content: str) -> str:
    import json

    def replace_fenced(match: re.Match[str]) -> str:
        return "" if _json_contains_ai_action(match.group(1)) else match.group(0)

    text = _AI_ACTION_BLOCK_RE.sub(replace_fenced, content)

    kept_lines: list[str] = []
    for line in text.splitlines():
        stripped_line = line.strip()
        if stripped_line.startswith("{") and stripped_line.endswith("}"):
            try:
                payload = json.loads(stripped_line)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict) and payload.get("ai_action"):
                continue
        kept_lines.append(line)

    cleaned = "\n".join(kept_lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def extract_actions_from_assistant_text(content: str) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for match in _AI_ACTION_BLOCK_RE.finditer(content):
        import json

        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("ai_action"):
            action = payload["ai_action"]
            if isinstance(action, dict):
                actions.append(action)
            continue
        if isinstance(payload, dict) and payload.get("type"):
            actions.append(payload)
        if isinstance(payload, list):
            actions.extend(item for item in payload if isinstance(item, dict))
    return actions


def merge_extracted_actions(session_id: str, assistant_text: str, *, message_id: str | None = None) -> None:
    store = get_ai_research_store()
    session = store.get_session(session_id)
    if not session:
        return

    existing_ids = {item.get("id") for item in (session.get("actions") or [])}
    for raw in extract_actions_from_assistant_text(assistant_text):
        action_id = raw.get("id") or str(uuid.uuid4())
        if action_id in existing_ids:
            continue
        store.upsert_action(
            session_id,
            {
                "id": action_id,
                "type": raw.get("type") or "note",
                "title": raw.get("title") or "Suggested action",
                "status": raw.get("status") or "open",
                "payload": raw.get("payload") or raw.get("strategy") or {},
                "sources": raw.get("sources") or [],
                "message_id": message_id,
            },
        )
        existing_ids.add(action_id)
