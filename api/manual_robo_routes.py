import sys
import os
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import APIRouter, HTTPException
from manual_robo.models import StartRoboRequest, StopRoboRequest
from manual_robo.engine import ManualRoboEngine
from manual_robo import db

log = logging.getLogger("manual_robo")

router = APIRouter(prefix="/api/robo", tags=["manual_robo"])

_active_engines: dict[int, ManualRoboEngine] = {}


def _get_client():
    from api.server import get_client
    return get_client()


@router.post("/start")
async def start_robo(req: StartRoboRequest):
    active = db.get_active_sessions()
    if active:
        raise HTTPException(
            status_code=400,
            detail=f"Already have an active session (id={active[0]['id']}). Stop it first."
        )

    session_id = db.create_session(
        symbol=req.symbol,
        token=req.token,
        exchange=req.exchange,
        configured_capital=req.configured_capital,
        daily_profit_target_pct=req.daily_profit_target_pct,
        long_percent=req.long_percent,
        short_percent=req.short_percent,
        initial_threshold=req.initial_threshold,
        quantity=0,  # computed at order time as configured_capital / ltp
    )

    # Store closing window in session for engine to use
    conn = db.get_connection()
    conn.execute(
        "UPDATE sessions SET stopped_at = NULL WHERE id = ?", (session_id,)
    )
    conn.commit()
    conn.close()

    # Patch session with closing window (engine needs it for prev close fetch)
    session = db.get_session(session_id)
    session["closing_start"] = req.closing_start
    session["closing_end"] = req.closing_end

    client = _get_client()
    engine = ManualRoboEngine(client, session_id)
    engine.session["closing_start"] = req.closing_start
    engine.session["closing_end"] = req.closing_end

    await engine.start()
    _active_engines[session_id] = engine

    log.info("[API] Robo started. session_id=%d", session_id)
    return {
        "status": True,
        "message": "ManualRobo started",
        "session_id": session_id,
    }


@router.post("/stop")
async def stop_robo(req: StopRoboRequest):
    engine = _active_engines.get(req.session_id)
    if not engine:
        session = db.get_session(req.session_id)
        if session and session["status"] == "active":
            db.update_session_status(req.session_id, "stopped")
            return {"status": True, "message": "Session marked stopped (engine not running)"}
        raise HTTPException(status_code=404, detail="No active engine for this session")

    await engine.stop("stopped")
    del _active_engines[req.session_id]

    return {"status": True, "message": "ManualRobo stopped", "session_id": req.session_id}


@router.get("/status")
async def get_status(session_id: int):
    engine = _active_engines.get(session_id)
    if engine:
        return {"status": True, "data": engine.get_status()}

    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    orders = db.get_orders_for_session(session_id)
    ltp_history = db.get_ltp_history(session_id, limit=5)
    return {
        "status": True,
        "data": {
            "session": session,
            "state": session["status"],
            "pending_orders": [],
            "recent_ltp": ltp_history,
            "orders": orders,
        }
    }


@router.get("/orders")
async def get_orders(session_id: int):
    orders = db.get_orders_for_session(session_id)
    return {"status": True, "data": orders}


@router.get("/sessions")
async def get_sessions():
    sessions = db.get_today_sessions()
    return {"status": True, "data": sessions}
