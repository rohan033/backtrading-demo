"""Background monitor loop for trading sessions in monitor state."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from control_plane.agent_trade_completion import (
    extract_exit_actions,
    extract_trade_completions,
    extract_update_order_actions,
)
from control_plane.trading_session_agent_common import (
    schedule_phase_task,
    stream_agent_prompt,
)
from control_plane.trading_session_prompts import trading_session_prompt_prefix, wrap_trading_session_prompt
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

MONITOR_POLL_SEC = float(os.getenv("TRADING_SESSION_MONITOR_POLL_SEC", "60"))


def build_monitor_prompt(session: dict[str, Any], context: dict[str, Any], store: TradingSessionStore, session_id: str) -> str:
    from control_plane.agent_monitor import _execute_monitor_instructions

    focus = {
        "symbol": session.get("symbol"),
        "token": session.get("token"),
        "exchange": session.get("exchange"),
        "broker": session.get("broker"),
        "account_env": session.get("account_env"),
        "execution_id": session.get("engine_id"),
        "max_available_capital": session.get("max_capital"),
        "profit_target": session.get("profit_target"),
        "total_pnl": session.get("total_pnl"),
    }
    focus_json = json.dumps(focus, ensure_ascii=False, indent=2)
    context_json = json.dumps(context, ensure_ascii=False, indent=2)
    instructions = _execute_monitor_instructions()
    body = (
        f"{trading_session_prompt_prefix(session)}\n\n"
        f"[Trading session monitor batch] Session {session.get('id')} — {session.get('symbol')}.\n\n"
        f"Trade focus:\n```json\n{focus_json}\n```\n\n"
        f"Live context:\n```json\n{context_json}\n```\n\n"
        f"{instructions}\n"
    )
    return wrap_trading_session_prompt(store, session_id, body)


async def _collect_monitor_context(session: dict[str, Any]) -> dict[str, Any]:
    symbol = str(session.get("symbol") or "")
    broker = str(session.get("broker") or "etoro").lower()
    account_env = str(session.get("account_env") or "demo")
    token = session.get("token")

    context: dict[str, Any] = {
        "symbol": symbol,
        "session_pnl": session.get("total_pnl"),
        "profit_target": session.get("profit_target"),
        "execution_id": session.get("engine_id"),
    }

    if broker == "etoro" and symbol and token:
        try:
            from brokers.etoro.candles import CANDLE_INTERVAL_ONE_MINUTE, aget_historical_candles

            candles = await aget_historical_candles(
                symbol=symbol,
                token=str(token),
                exchange=str(session.get("exchange") or "ETORO"),
                account_env=account_env,
                interval=CANDLE_INTERVAL_ONE_MINUTE,
                count=30,
            )
            if candles:
                context["recent_candles"] = candles[-10:]
                context["last_price"] = candles[-1].get("close") or candles[-1].get("Close")
        except Exception as exc:
            log.debug("[TRADING_SESSION] monitor candles skip %s: %s", symbol, exc)

    try:
        from control_plane.agent_monitor import collect_news_events
        from control_plane.news_service import get_news_service

        news_svc = get_news_service()
        events = await collect_news_events(symbol, news_svc)
        if events:
            context["headlines"] = [e.payload for e in events[:6]]
    except Exception as exc:
        log.debug("[TRADING_SESSION] monitor news skip: %s", exc)

    return context


async def _execute_session_exit_actions(
    session_id: str,
    session: dict[str, Any],
    actions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    from control_plane.engine_process_manager import EngineProcessManager
    from control_plane.engine_registry import EngineRegistry

    registry = EngineRegistry()
    manager = EngineProcessManager(registry)
    default_eid = str(session.get("engine_id") or "")
    results: list[dict[str, Any]] = []

    for payload in actions:
        execution_id = str(payload.get("execution_id") or default_eid).strip()
        if not execution_id:
            continue
        engine = registry.get_engine(execution_id)
        if not engine:
            continue
        if manager.stop_engine(execution_id):
            results.append({
                "execution_id": execution_id,
                "status": "stopped",
                "reason": payload.get("reason"),
            })
            log.info(
                "[TRADING_SESSION] stopped execution=%s session=%s reason=%s",
                execution_id,
                session_id,
                payload.get("reason"),
            )
    return results


async def _execute_session_update_actions(
    session: dict[str, Any],
    actions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    from control_plane.engine_registry import EngineRegistry

    registry = EngineRegistry()
    default_eid = str(session.get("engine_id") or "")
    results: list[dict[str, Any]] = []

    for payload in actions:
        execution_id = str(payload.get("execution_id") or default_eid).strip()
        if not execution_id:
            continue
        engine = registry.get_engine(execution_id)
        if not engine:
            continue

        metadata = dict(engine.get("metadata") or {})
        executor_payload = dict(metadata.get("executor_payload") or {})
        execution_config = dict(metadata.get("execution_config") or {})

        if payload.get("close_price") is not None:
            try:
                price = float(payload["close_price"])
                executor_payload["close_price"] = price
                execution_config["close_price"] = price
            except (TypeError, ValueError):
                pass

        for field in ("long_percent", "short_percent", "initial_threshold", "max_available_capital"):
            if payload.get(field) is not None:
                try:
                    value = float(payload[field])
                    executor_payload[field] = value
                    execution_config[field] = value
                except (TypeError, ValueError):
                    pass

        metadata["executor_payload"] = executor_payload
        metadata["execution_config"] = execution_config
        registry.update_engine(execution_id, {"metadata": metadata})
        results.append({"execution_id": execution_id, "status": "updated"})

    return results


async def process_session_monitor_actions(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
    assistant_text: str,
) -> bool:
    """Process monitor agent actions. Returns True if session should stop."""
    session = store.get_session(session_id)
    if not session:
        return True

    await _execute_session_exit_actions(session_id, session, extract_exit_actions(assistant_text))
    await _execute_session_update_actions(session, extract_update_order_actions(assistant_text))

    completions = extract_trade_completions(assistant_text)
    if not completions:
        return False

    total_pnl = float(session.get("total_pnl") or 0)
    for comp in completions:
        try:
            pnl = float(comp.get("pnl") or 0)
        except (TypeError, ValueError):
            pnl = 0.0
        total_pnl += pnl
        store.append_event(session_id, "trade_closed", {
            "symbol": comp.get("symbol") or session.get("symbol"),
            "pnl": pnl,
            "outcome": comp.get("outcome"),
        })

    store.update_session(session_id, {"total_pnl": total_pnl})
    profit_target = float(session.get("profit_target") or 0)
    if profit_target > 0 and total_pnl >= profit_target:
        await engine.stop_session(session_id, f"Profit target reached (${total_pnl:.2f})")
    else:
        await engine.stop_session(session_id, "Trade complete")
    return True


async def run_monitor_batch(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> bool:
    """Run one monitor agent batch. Returns True if session ended."""
    session = store.get_session(session_id)
    if not session or session.get("state") != "monitor":
        return True

    profit_target = float(session.get("profit_target") or 0)
    total_pnl = float(session.get("total_pnl") or 0)
    if profit_target > 0 and total_pnl >= profit_target:
        await engine.stop_session(session_id, f"Profit target reached (${total_pnl:.2f})")
        return True

    context = await _collect_monitor_context(session)
    prompt = build_monitor_prompt(session, context, store, session_id)
    store.append_event(session_id, "monitor_batch_started", {"execution_id": session.get("engine_id")})

    try:
        assistant_text = await stream_agent_prompt(
            session_id=session_id,
            store=store,
            state="monitor",
            prompt=prompt,
        )
        return await process_session_monitor_actions(session_id, store, engine, assistant_text)
    except Exception as exc:
        log.exception("[TRADING_SESSION] monitor batch failed session=%s", session_id)
        store.append_event(session_id, "monitor_batch_failed", {"reason": str(exc)})
        return False


async def run_monitor_loop(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    store.append_event(session_id, "monitor_started", {"poll_sec": MONITOR_POLL_SEC})
    try:
        while True:
            session = store.get_session(session_id)
            if not session or session.get("state") != "monitor":
                break

            ended = await run_monitor_batch(session_id, store, engine)
            if ended:
                break

            session = store.get_session(session_id)
            if not session or session.get("state") != "monitor":
                break

            await asyncio.sleep(MONITOR_POLL_SEC)
    except asyncio.CancelledError:
        store.append_event(session_id, "monitor_stopped", {"reason": "cancelled"})
        raise
    finally:
        log.info("[TRADING_SESSION] monitor loop ended session=%s", session_id)


def schedule_monitor_loop(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    schedule_phase_task(
        f"{session_id}:monitor",
        lambda: run_monitor_loop(session_id, store, engine),
    )
