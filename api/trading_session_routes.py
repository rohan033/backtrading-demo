from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from control_plane.trading_session_engine import TradingSessionEngine
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

router = APIRouter(prefix="/api/control/trading-sessions", tags=["trading-sessions"])

_store: TradingSessionStore | None = None
_engine: TradingSessionEngine | None = None


def get_trading_session_store() -> TradingSessionStore:
    global _store
    if _store is None:
        _store = TradingSessionStore()
    return _store


def get_trading_session_engine() -> TradingSessionEngine:
    global _engine
    if _engine is None:
        _engine = TradingSessionEngine(get_trading_session_store())
    return _engine


class CreateTradingSessionRequest(BaseModel):
    symbol: str | None = None
    token: str | None = None
    exchange: str | None = None
    broker: str = "etoro"
    account_env: str = "demo"
    max_capital: float = Field(default=5000, ge=0)
    profit_target: float = Field(default=500, ge=0)


class DispatchPromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)


class StopSessionRequest(BaseModel):
    reason: str = "Stopped by user"


@router.get("", operation_id="list_trading_sessions", summary="List trading sessions")
def list_trading_sessions(state: str | None = None, limit: int = 100):
    rows = get_trading_session_store().list_sessions(state=state, limit=limit)
    return {"status": True, "data": rows}


@router.post("", operation_id="create_trading_session", summary="Create a trading session")
async def create_trading_session(req: CreateTradingSessionRequest):
    detail = await get_trading_session_engine().create_session(req.model_dump())
    return {"status": True, "data": detail}


@router.get("/{session_id}", operation_id="get_trading_session", summary="Get trading session with state log")
def get_trading_session(session_id: str):
    detail = get_trading_session_engine().get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


@router.post("/{session_id}/prompt", operation_id="dispatch_trading_session_prompt", summary="Dispatch prompt to session")
async def dispatch_trading_session_prompt(session_id: str, req: DispatchPromptRequest):
    detail = await get_trading_session_engine().dispatch_prompt(session_id, req.prompt)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


@router.post("/{session_id}/stop", operation_id="stop_trading_session", summary="Kill switch — stop session")
async def stop_trading_session(session_id: str, req: StopSessionRequest | None = None):
    reason = (req.reason if req else None) or "Stopped by user"
    detail = await get_trading_session_engine().stop_session(session_id, reason)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": detail}


@router.delete("/{session_id}", operation_id="delete_trading_session", summary="Delete a trading session")
async def delete_trading_session(session_id: str):
    deleted = await get_trading_session_engine().delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": True, "data": {"id": session_id, "deleted": True}}


@router.get("/{session_id}/events", operation_id="poll_trading_session_events", summary="Poll session events")
def poll_trading_session_events(session_id: str, since_id: int = 0, limit: int = 500):
    store = get_trading_session_store()
    if not store.get_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    events = store.list_events(session_id, since_id=since_id, limit=limit)
    return {"status": True, "data": events}


POLL_INTERVAL_SEC = 0.5


async def handle_trading_session_websocket(ws: WebSocket, session_id: str, since_id: int = 0) -> None:
    store = get_trading_session_store()
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
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("[TRADING_SESSION_WS] closed session=%s: %s", session_id, exc)
