"""REST + websocket API for durable 1% trading sessions."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from control_plane.one_percent_session_engine import get_one_percent_session_engine
from control_plane.one_percent_session_store import (
    DEFAULT_CONFIG,
    get_one_percent_session_store,
    normalize_config,
)

log = logging.getLogger("backtrading")

router = APIRouter(prefix="/api/control/one-percent-sessions", tags=["one-percent-sessions"])


class CreateOnePercentSessionRequest(BaseModel):
    account_env: str = "demo"
    capital: float = Field(default=1000, ge=1, le=1_000_000)
    target_pct: float = Field(default=1.0, ge=0.1, le=50)
    take_profit_pct: float = Field(default=1.5, ge=0.1, le=50)
    stop_loss_pct: float = Field(default=2.0, ge=0.1, le=50)
    max_attempts: int = Field(default=3, ge=1, le=10)
    selection_mode: str = "deterministic"
    min_score: float = Field(default=0.0, ge=0, le=10_000)
    screener_mode: str = "auto"
    query_keys: list[str] = Field(default_factory=list)
    screener_ids: list[str] = Field(default_factory=list)
    focus_symbols: list[str] = Field(default_factory=list)
    agent_model: str | None = None
    agent_model_params: list[dict[str, str]] = Field(default_factory=list)


class StopOnePercentSessionRequest(BaseModel):
    reason: str = "Stopped by user"


@router.get("/defaults", operation_id="one_percent_session_defaults")
def get_defaults():
    return {"status": True, "data": normalize_config(DEFAULT_CONFIG)}


@router.get("/presets", operation_id="one_percent_session_presets")
def list_presets():
    from control_plane.screener_query import ONE_PERCENT_PRESET_UI_KEYS, ONE_PERCENT_QUERY_PRESETS

    rows = []
    for key in ONE_PERCENT_PRESET_UI_KEYS:
        preset = ONE_PERCENT_QUERY_PRESETS.get(key) or {}
        rows.append({
            "key": key,
            "name": preset.get("name") or key,
            "description": preset.get("description") or "",
            "phase": preset.get("phase") or "regular",
        })
    return {"status": True, "data": rows}


@router.get("/eligibility", operation_id="one_percent_session_eligibility")
async def get_eligibility(account_env: str = "demo", capital: float = 1000):
    data = await get_one_percent_session_engine().check_eligibility(
        account_env=account_env,
        capital=capital,
    )
    return {"status": True, "data": data}


@router.get("", operation_id="list_one_percent_sessions")
def list_sessions(account_env: str | None = None, limit: int = 100):
    rows = get_one_percent_session_store().list_sessions(
        account_env=account_env,
        limit=limit,
    )
    return {"status": True, "data": rows}


@router.post("", operation_id="create_one_percent_session")
async def create_session(req: CreateOnePercentSessionRequest):
    eligibility = await get_one_percent_session_engine().check_eligibility(
        account_env=req.account_env,
        capital=req.capital,
    )
    if not eligibility.get("can_start"):
        raise HTTPException(
            status_code=400,
            detail="; ".join(eligibility.get("reasons") or ["Cannot start session"]),
        )
    try:
        detail = await get_one_percent_session_engine().create_and_start(
            account_env=req.account_env,
            config={
                "capital": req.capital,
                "target_pct": req.target_pct,
                "take_profit_pct": req.take_profit_pct,
                "stop_loss_pct": req.stop_loss_pct,
                "max_attempts": req.max_attempts,
                "selection_mode": req.selection_mode,
                "min_score": req.min_score,
                "screener_mode": req.screener_mode,
                "query_keys": req.query_keys,
                "screener_ids": req.screener_ids,
                "focus_symbols": req.focus_symbols,
                "agent_model": req.agent_model,
                "agent_model_params": req.agent_model_params,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": True, "data": detail}


@router.get("/{session_id}", operation_id="get_one_percent_session")
def get_session(session_id: str):
    detail = get_one_percent_session_store().get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


@router.get("/{session_id}/events", operation_id="poll_one_percent_session_events")
def poll_events(session_id: str, since_id: int = 0, limit: int = 500):
    store = get_one_percent_session_store()
    if not store.get_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    events = store.list_events(session_id, since_id=since_id, limit=limit)
    return {"status": True, "data": events}


@router.post("/{session_id}/stop", operation_id="stop_one_percent_session")
async def stop_session(session_id: str, req: StopOnePercentSessionRequest | None = None):
    reason = (req.reason if req else None) or "Stopped by user"
    detail = await get_one_percent_session_engine().stop_session(session_id, reason)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


class CloseOnePercentPositionRequest(BaseModel):
    reason: str = "Manual close"
    # True when the UI already closed via /api/control/etoro/positions/.../close
    broker_already_closed: bool = False


@router.post("/{session_id}/close-position", operation_id="close_one_percent_position")
async def close_position(session_id: str, req: CloseOnePercentPositionRequest | None = None):
    reason = (req.reason if req else None) or "Manual close"
    broker_already_closed = bool(req.broker_already_closed) if req else False
    try:
        detail = await get_one_percent_session_engine().request_close_position(
            session_id,
            reason=reason,
            broker_already_closed=broker_already_closed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


@router.delete("/{session_id}", operation_id="delete_one_percent_session")
async def delete_session(session_id: str):
    store = get_one_percent_session_store()
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["state"] not in {"finished", "stopped"}:
        await get_one_percent_session_engine().stop_session(session_id, "Deleted by user")
    if not store.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": {"id": session_id, "deleted": True}}


POLL_INTERVAL_SEC = 0.5


async def handle_one_percent_session_websocket(
    ws: WebSocket,
    session_id: str,
    since_id: int = 0,
) -> None:
    store = get_one_percent_session_store()
    if not store.get_session(session_id):
        await ws.close(code=4404, reason="Session not found")
        return

    await ws.accept()
    cursor = max(0, since_id)
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=POLL_INTERVAL_SEC)
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                    continue
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                break

            events = store.list_events(session_id, since_id=cursor, limit=100)
            for event in events:
                cursor = max(cursor, int(event["id"]))
                await ws.send_json({"type": "event", "event": event})

            session = store.get_session(session_id)
            if session:
                await ws.send_json({"type": "session", "session": session})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("[1PC_WS] closed session=%s: %s", session_id, exc)
