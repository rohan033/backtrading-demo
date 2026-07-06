"""Auto-execute monitor entries when the agent reports sufficient confidence (Trade mode)."""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from api.fenced_json import iter_fenced_json_blocks
from control_plane.agent_thread_state import AGENT_PRODUCT, UI_PHASE_TRADING

log = logging.getLogger("backtrading.agent_autonomous")

AUTONOMOUS_ENTRY_TYPES = frozenset({"autonomous_entry", "auto_enter", "momentum_enter"})
EXECUTION_SOURCE_AI_RESEARCH = "ai_research"


def autonomous_min_confidence() -> float:
    try:
        return float(os.getenv("AGENT_AUTONOMOUS_MIN_CONFIDENCE", "50"))
    except ValueError:
        return 50.0


def extract_autonomous_entries(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for _, payload in iter_fenced_json_blocks(text):
        if not isinstance(payload, dict):
            continue
        action = payload.get("ai_action")
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("type") or "").lower()
        if action_type not in AUTONOMOUS_ENTRY_TYPES:
            continue
        body = dict(action.get("payload") or {})
        body["type"] = action_type
        body["title"] = action.get("title") or body.get("title")
        if body.get("confidence_pct") is None and body.get("confidence") is not None:
            body["confidence_pct"] = body.get("confidence")
        entries.append(body)
    return entries


def _symbol_root(symbol: str) -> str:
    return str(symbol or "").strip().upper().split("-")[0]


def _active_symbols(session: dict[str, Any]) -> set[str]:
    active: set[str] = set()
    focus = (session.get("metadata") or {}).get("focus") or {}
    if focus.get("symbol"):
        active.add(_symbol_root(str(focus["symbol"])))
    for action in session.get("actions") or []:
        payload = action.get("payload") or {}
        if not payload.get("symbol"):
            continue
        status = str(action.get("status") or "").lower()
        if payload.get("execution_id") or status in {"running", "active", "starting"}:
            active.add(_symbol_root(str(payload["symbol"])))
    return active


def _link_entry_to_thread(
    store,
    thread_id: str,
    execution_id: str,
    payload: dict[str, Any],
    *,
    entry_price: float,
) -> None:
    symbol = str(payload.get("symbol") or "")
    broker = str(payload.get("broker") or "etoro")
    account_env = str(payload.get("account_env") or "demo")
    action_id = str(payload.get("action_id") or uuid.uuid4())

    store.upsert_action(
        thread_id,
        {
            "id": action_id,
            "type": "strategy_suggestion",
            "title": str(payload.get("title") or f"{_symbol_root(symbol)} autonomous entry"),
            "status": "running",
            "payload": {
                **payload,
                "broker": broker,
                "account_env": account_env,
                "close_price": entry_price,
                "execution_id": execution_id,
                "autonomous": True,
                "confidence_pct": payload.get("confidence_pct"),
            },
        },
    )

    metadata = dict((store.get_session(thread_id) or {}).get("metadata") or {})
    metadata["ui_phase"] = UI_PHASE_TRADING
    metadata["focus"] = {
        "symbol": symbol,
        "token": payload.get("token"),
        "exchange": payload.get("exchange") or ("ETORO" if broker == "etoro" else "NSE"),
        "broker": broker,
        "account_env": account_env,
        "close_price": entry_price,
        "long_percent": payload.get("long_percent"),
        "short_percent": payload.get("short_percent"),
        "initial_threshold": payload.get("initial_threshold"),
        "max_available_capital": payload.get("max_available_capital"),
        "execution_id": execution_id,
    }
    store.update_session(thread_id, {"metadata": metadata})


async def execute_autonomous_entries(thread_id: str, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from api.ai_research_routes import get_ai_research_store
    from api.server import MomentumEnterRequest, momentum_enter
    from fastapi import HTTPException

    if not actions:
        return []

    store = get_ai_research_store()
    session = store.get_session(thread_id) or {}
    if (session.get("metadata") or {}).get("product") != AGENT_PRODUCT:
        return []
    if str(session.get("interaction_mode") or "ask") != "execute":
        log.info("[AGENT_AUTONOMOUS] skip entries thread=%s — not in execute mode", thread_id)
        return []

    min_conf = autonomous_min_confidence()
    active_symbols = _active_symbols(session)
    metadata = session.get("metadata") or {}
    default_broker = str(metadata.get("broker") or "etoro")
    default_env = str(metadata.get("account_env") or "demo")

    ranked = sorted(
        actions,
        key=lambda row: float(row.get("confidence_pct") or row.get("confidence") or 0),
        reverse=True,
    )

    results: list[dict[str, Any]] = []
    for payload in ranked:
        try:
            confidence = float(payload.get("confidence_pct") or payload.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < min_conf:
            log.info(
                "[AGENT_AUTONOMOUS] skip %s confidence=%.1f < %.1f",
                payload.get("symbol"),
                confidence,
                min_conf,
            )
            continue

        symbol = str(payload.get("symbol") or "").strip()
        if not symbol:
            continue
        if _symbol_root(symbol) in active_symbols:
            log.info("[AGENT_AUTONOMOUS] skip %s — already active on thread", symbol)
            continue

        broker = str(payload.get("broker") or default_broker).lower()
        account_env = str(payload.get("account_env") or default_env).lower()
        token = str(payload.get("token") or "").strip()
        if not token:
            log.warning("[AGENT_AUTONOMOUS] skip %s — missing token", symbol)
            continue

        try:
            entry_price = float(payload.get("close_price") or payload.get("entry_price") or 0)
        except (TypeError, ValueError):
            entry_price = 0.0
        if entry_price <= 0:
            log.warning("[AGENT_AUTONOMOUS] skip %s — invalid entry price", symbol)
            continue

        if broker != "etoro":
            log.warning("[AGENT_AUTONOMOUS] skip %s — autonomous entry supports eToro only", symbol)
            continue

        try:
            response = await momentum_enter(
                MomentumEnterRequest(
                    broker="etoro",
                    account_env=account_env,
                    symbol=symbol,
                    token=token,
                    exchange=str(payload.get("exchange") or "ETORO"),
                    close_price=entry_price,
                    long_percent=float(payload.get("long_percent") or 2),
                    short_percent=float(payload.get("short_percent") or 1),
                    max_available_capital=float(payload.get("max_available_capital") or 5000),
                    allow_partial_stocks=True,
                    source_id=EXECUTION_SOURCE_AI_RESEARCH,
                    source_meta_id=thread_id,
                )
            )
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            log.error("[AGENT_AUTONOMOUS] entry failed symbol=%s: %s", symbol, detail)
            results.append({
                "symbol": symbol,
                "status": "failed",
                "confidence_pct": confidence,
                "error": detail,
            })
            continue
        except Exception as exc:
            log.error("[AGENT_AUTONOMOUS] entry failed symbol=%s: %s", symbol, exc, exc_info=True)
            results.append({
                "symbol": symbol,
                "status": "failed",
                "confidence_pct": confidence,
                "error": str(exc),
            })
            continue

        data = (response or {}).get("data") or {}
        execution_id = str(data.get("execution_id") or "").strip()
        if not execution_id:
            results.append({"symbol": symbol, "status": "failed", "error": "no execution_id"})
            continue

        _link_entry_to_thread(store, thread_id, execution_id, payload, entry_price=entry_price)
        active_symbols.add(_symbol_root(symbol))
        results.append({
            "symbol": symbol,
            "execution_id": execution_id,
            "status": "entered",
            "confidence_pct": confidence,
            "entry_price": entry_price,
        })
        log.info(
            "[AGENT_AUTONOMOUS] entered symbol=%s execution=%s confidence=%.1f thread=%s",
            symbol,
            execution_id,
            confidence,
            thread_id,
        )
        # One new entry per monitor batch to limit risk.
        break

    return results
