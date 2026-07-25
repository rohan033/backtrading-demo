"""Agentic session trading API.

All responses are shaped {"status": true, "data": ...}; errors raise
HTTPException with detail. The JSON contracts here are consumed by the
frontend being built in parallel — do not change field names or shapes.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from control_plane.agentic.config import (
    DEFAULT_START_BALANCE,
    config_overrides_from_prompt,
    merge_config,
)
from control_plane.agentic.market_hunter import get_market_hunter
from control_plane.agentic.session_engine import get_agentic_session_manager
from control_plane.agentic.session_store import get_agentic_session_store

router = APIRouter(prefix="/api/agentic", tags=["agentic"])


class CreateSessionRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    prompt: str | None = Field(default=None, max_length=4000)
    account_env: Literal["demo", "live"]
    start_balance: float | None = Field(default=None, gt=0)
    config: dict[str, Any] | None = None


def _session_json(session: dict[str, Any]) -> dict[str, Any]:
    store = get_agentic_session_store()
    return {
        "id": session["id"],
        "name": session["name"],
        "prompt": session.get("prompt"),
        "status": session["status"],
        "account_env": session["account_env"],
        "start_balance": session["start_balance"],
        "config": session.get("config") or {},
        "started_at": session.get("started_at"),
        "stopped_at": session.get("stopped_at"),
        "stop_reason": session.get("stop_reason"),
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
        "stats": store.session_stats(session["id"]),
    }


def _position_json(position: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": position["id"],
        "session_id": position["session_id"],
        "ticker": position["ticker"],
        "state": position["state"],
        "exit_state": position["exit_state"],
        "units": position["units"],
        "buy_price": position["buy_price"],
        "stop_loss": position["stop_loss"],
        "current_price": position["current_price"],
        "realized_pnl": position["realized_pnl"],
        "unrealized_pnl": position["unrealized_pnl"],
        "intent_id": position["intent_id"],
        "opened_at": position["opened_at"],
        "closed_at": position["closed_at"],
    }


def _get_session_or_404(session_id: str) -> dict[str, Any]:
    session = get_agentic_session_store().get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agentic session not found")
    return session


@router.get("/sessions", operation_id="list_agentic_sessions", summary="List agentic trading sessions")
async def list_sessions():
    sessions = get_agentic_session_store().list_sessions()
    return {"status": True, "data": [_session_json(s) for s in sessions]}


@router.post("/sessions", operation_id="create_agentic_session", summary="Create and start an agentic trading session")
async def create_session(req: CreateSessionRequest):
    store = get_agentic_session_store()
    prompt = (req.prompt or "").strip() or None
    config = merge_config(req.config, prompt=prompt)
    start_balance = float(req.start_balance or DEFAULT_START_BALANCE)
    name = (req.name or "").strip() or f"Agentic session ({req.account_env})"

    session = store.create_session(
        name=name,
        prompt=prompt,
        account_env=req.account_env,
        start_balance=start_balance,
        config=config,
    )
    if prompt:
        prompt_overrides = config_overrides_from_prompt(prompt)
        store.add_event(
            session["id"],
            "info",
            f"Session prompt: {prompt}",
            meta={"prompt": prompt, "derived_config_overrides": prompt_overrides},
        )
    store.add_event(
        session["id"],
        "info",
        f"Session started ({req.account_env}, ${start_balance:.2f}"
        f"{', dry-run' if config.get('dry_run') else ', LIVE ORDERS'})",
        meta={"config": config},
    )
    get_agentic_session_manager().start_session(session["id"])
    return {"status": True, "data": _session_json(session)}


@router.get("/sessions/{session_id}", operation_id="get_agentic_session", summary="Get one agentic session with stats")
async def get_session(session_id: str):
    session = _get_session_or_404(session_id)
    return {"status": True, "data": _session_json(session)}


@router.post("/sessions/{session_id}/stop", operation_id="stop_agentic_session", summary="Stop an agentic session (keeps managing open positions)")
async def stop_session(session_id: str):
    _get_session_or_404(session_id)
    session = await get_agentic_session_manager().stop_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agentic session not found")
    return {"status": True, "data": _session_json(session)}


@router.delete("/sessions/{session_id}", operation_id="delete_agentic_session", summary="Delete a stopped agentic session")
async def delete_session(session_id: str):
    session = _get_session_or_404(session_id)
    if session["status"] != "stopped":
        raise HTTPException(status_code=409, detail="Stop the session before deleting it")
    get_agentic_session_manager().stop_engine_task(session_id)
    get_agentic_session_store().delete_session(session_id)
    return {"status": True}


@router.get("/sessions/{session_id}/events", operation_id="list_agentic_session_events", summary="Session event log (ascending; poll with after_id)")
async def list_session_events(
    session_id: str,
    after_id: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
):
    _get_session_or_404(session_id)
    events = get_agentic_session_store().list_events(
        session_id, after_id=after_id, limit=limit
    )
    return {"status": True, "data": events}


@router.get("/sessions/{session_id}/positions", operation_id="list_agentic_session_positions", summary="Session positions")
async def list_session_positions(session_id: str):
    _get_session_or_404(session_id)
    positions = get_agentic_session_store().list_positions(session_id)
    return {"status": True, "data": [_position_json(p) for p in positions]}


@router.post(
    "/sessions/{session_id}/positions/{position_id}/close",
    operation_id="close_agentic_session_position",
    summary="Force-close one session position via the broker (or simulated in dry-run)",
)
async def close_session_position(session_id: str, position_id: str):
    _get_session_or_404(session_id)
    position = get_agentic_session_store().get_position(position_id)
    if position is None or position["session_id"] != session_id:
        raise HTTPException(status_code=404, detail="Position not found in this session")
    if position["state"] in ("closed", "failed"):
        raise HTTPException(status_code=409, detail=f"Position already {position['state']}")
    updated = await get_agentic_session_manager().force_close_position(
        session_id, position_id
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Position not found in this session")
    return {"status": True, "data": _position_json(updated)}


@router.get("/suggestions", operation_id="list_agentic_suggestions", summary="Latest market hunter suggestions (newest first)")
async def list_suggestions(limit: int = Query(30, ge=1, le=100)):
    return {"status": True, "data": get_market_hunter().recent_suggestions(limit=limit)}
