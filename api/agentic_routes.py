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
    patch_config,
)
from control_plane.agentic.market_hunter import get_market_hunter
from control_plane.agentic.session_engine import get_agentic_session_manager
from control_plane.agentic.session_store import get_agentic_session_store
from control_plane.agentic.snapshot import SessionSnapshot

router = APIRouter(prefix="/api/agentic", tags=["agentic"])


class CreateSessionRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    prompt: str | None = Field(default=None, max_length=4000)
    account_env: Literal["demo", "live"]
    start_balance: float | None = Field(default=None, gt=0)
    config: dict[str, Any] | None = None
    agent_model: str | None = Field(
        default=None,
        description="Cursor SDK model id for orchestrator and sub-agents",
    )
    agent_model_params: list[dict[str, str]] = Field(default_factory=list)


class UpdateAgentModelRequest(BaseModel):
    agent_model: str | None = Field(
        default=None,
        description="Cursor SDK model id; empty string clears to SDK default",
    )
    agent_model_params: list[dict[str, str]] | None = None


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
        "snapshot_version": int((session.get("snapshot") or {}).get("version") or 1),
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
    if req.agent_model is not None:
        config["agent_model"] = req.agent_model.strip() or None
    if req.agent_model_params:
        config["agent_model_params"] = req.agent_model_params
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
        f"{', simulated fills' if config.get('dry_run') else ', broker orders'}"
        f"{f', model={config.get('agent_model')}' if config.get('agent_model') else ''})",
        meta={"config": config},
    )
    screener_ids = config.get("screener_ids") or []
    tickers = config.get("tickers") or []
    if screener_ids or tickers:
        scope_parts: list[str] = []
        if screener_ids:
            scope_parts.append(f"{len(screener_ids)} screener(s)")
        if tickers:
            scope_parts.append(f"watchlist: {', '.join(str(t) for t in tickers)}")
        store.add_event(
            session["id"],
            "info",
            f"Session scope — {'; '.join(scope_parts)}",
            meta={"screener_ids": screener_ids, "tickers": tickers},
        )
    get_agentic_session_manager().start_session(session["id"])
    return {"status": True, "data": _session_json(session)}


@router.get("/sessions/{session_id}", operation_id="get_agentic_session", summary="Get one agentic session with stats")
async def get_session(session_id: str):
    session = _get_session_or_404(session_id)
    return {"status": True, "data": _session_json(session)}


@router.get(
    "/sessions/{session_id}/snapshot",
    operation_id="get_agentic_session_snapshot",
    summary="Get the atomic dashboard snapshot",
)
async def get_session_snapshot(session_id: str):
    _get_session_or_404(session_id)
    snapshot = SessionSnapshot(get_agentic_session_store(), session_id).hydrate()
    return {"status": True, "data": snapshot}


@router.post("/sessions/{session_id}/stop", operation_id="stop_agentic_session", summary="Stop an agentic session (keeps managing open positions)")
async def stop_session(session_id: str):
    _get_session_or_404(session_id)
    session = await get_agentic_session_manager().stop_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agentic session not found")
    return {"status": True, "data": _session_json(session)}


@router.post(
    "/sessions/{session_id}/pause",
    operation_id="pause_agentic_session",
    summary="Pause entries and strategic reasoning while risk monitoring continues",
)
async def pause_session(session_id: str):
    _get_session_or_404(session_id)
    session = get_agentic_session_manager().pause_session(session_id)
    return {"status": True, "data": _session_json(session)}


@router.post(
    "/sessions/{session_id}/resume",
    operation_id="resume_agentic_session",
    summary="Resume an agentic session",
)
async def resume_session(session_id: str):
    _get_session_or_404(session_id)
    session = get_agentic_session_manager().resume_session(session_id)
    return {"status": True, "data": _session_json(session)}


@router.patch(
    "/sessions/{session_id}/agent-model",
    operation_id="update_agentic_session_model",
    summary="Update the Cursor model used by the main orchestrator and sub-agents",
)
async def update_session_agent_model(session_id: str, req: UpdateAgentModelRequest):
    import json

    store = get_agentic_session_store()
    session = _get_session_or_404(session_id)
    patch: dict[str, Any] = {}
    if req.agent_model is not None:
        patch["agent_model"] = req.agent_model.strip() or None
    if req.agent_model_params is not None:
        patch["agent_model_params"] = req.agent_model_params
    if not patch:
        raise HTTPException(status_code=400, detail="No model fields to update")
    config = patch_config(session.get("config") or {}, patch)
    updated = store.update_session(
        session_id,
        {"config_json": json.dumps(config, separators=(",", ":"), default=str)},
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agentic session not found")
    label = config.get("agent_model") or "SDK default"
    store.add_event(
        session_id,
        "info",
        f"Orchestrator model set to {label}",
        meta={"agent_model": config.get("agent_model"), "agent_model_params": config.get("agent_model_params")},
    )
    return {"status": True, "data": _session_json(updated)}


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


@router.get("/status", operation_id="get_agentic_status", summary="Market hunter heartbeat and scan stats")
async def get_agentic_status():
    hunter = get_market_hunter()
    return {
        "status": True,
        "data": {
            "hunter": hunter.status(),
            "running_sessions": len(
                get_agentic_session_store().list_sessions_by_status("running")
            ),
        },
    }
