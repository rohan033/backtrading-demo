"""Shared Cursor agent streaming and A2UI helpers for trading session phases."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any, Callable

from api.control_plane_mcp_tools import (
    is_mutation_mcp_tool_name,
    is_read_mcp_tool_name,
    normalize_mcp_tool_name,
)
from api.cursor_agent import REPO_READ_TOOL_NAMES, WEB_SEARCH_TOOL_NAMES
import json

from api.a2ui_bridge import expand_agent_text_to_surfaces, extract_a2ui_blocks, surface_component_props, tool_log_surface
from api.ai_research_routes import extract_actions_from_assistant_text
from api.tool_call_names import resolve_cursor_tool_name, tool_args_from_event

log = logging.getLogger("backtrading")

# Cursor SDK run lifecycle statuses — not trader-facing thinking content.
_LIFECYCLE_STATUS_NOISE = frozenset({
    "running",
    "finished",
    "started",
    "complete",
    "completed",
    "done",
    "idle",
})

_phase_tasks: dict[str, asyncio.Task] = {}
_phase_locks: dict[str, asyncio.Lock] = {}

_active_session_runs: dict[str, dict[str, Any]] = {}


def register_session_agent_run(
    session_id: str,
    *,
    cancel_event: asyncio.Event,
    active_run: dict[str, Any],
    run_id: str,
    state: str,
) -> None:
    _active_session_runs[session_id] = {
        "cancel_event": cancel_event,
        "active_run": active_run,
        "run_id": run_id,
        "state": state,
    }


def clear_session_agent_run(session_id: str) -> None:
    _active_session_runs.pop(session_id, None)


async def cancel_session_agent_run(session_id: str) -> None:
    entry = _active_session_runs.pop(session_id, None)
    if not entry:
        return
    cancel_event = entry.get("cancel_event")
    if cancel_event is not None:
        cancel_event.set()
    active_run = entry.get("active_run") or {}
    run = active_run.get("run")
    if run is not None:
        with contextlib.suppress(Exception):
            if hasattr(run, "supports") and run.supports("cancel"):
                await run.cancel()


def classify_tool_source(tool_name: str) -> str:
    normalized = normalize_mcp_tool_name(tool_name)
    if normalized in WEB_SEARCH_TOOL_NAMES:
        return "web"
    if is_read_mcp_tool_name(tool_name) or is_mutation_mcp_tool_name(tool_name):
        return "mcp"
    if normalized in REPO_READ_TOOL_NAMES:
        return "repo"
    return "tool"


def session_event_from_cursor(
    state: str,
    event: dict[str, Any],
    run_id: str,
) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    event_type = event.get("type")

    if event_type == "start":
        out.append(("agent_run_started", {"state": state, "run_id": run_id}))
        return out

    if event_type == "tool_call":
        resolved_name = resolve_cursor_tool_name(event)
        tool_log = tool_log_surface({**event, "tool_name": resolved_name})
        if tool_log:
            props = surface_component_props(tool_log)
            raw_name = str(
                props.get("toolName") or props.get("tool_name") or resolved_name or "tool"
            )
            args_blob = tool_args_from_event(event)
            payload: dict[str, Any] = {
                "tool_name": raw_name,
                "tool_source": classify_tool_source(raw_name),
                "tool_status": props.get("status") or event.get("tool_status"),
                "detail": props.get("detail") or "",
                "run_id": run_id,
            }
            if event.get("call_id"):
                payload["call_id"] = event.get("call_id")
            if args_blob:
                payload["args"] = json.dumps(args_blob, ensure_ascii=False, default=str)
                if not payload["detail"]:
                    payload["detail"] = payload["args"]
            out.append(("agent_tool_call", payload))
        return out

    if event_type == "text_delta":
        chunk = str(event.get("text") or "")
        if chunk:
            out.append(("agent_thinking", {"message": chunk, "run_id": run_id}))
        return out

    if event_type == "done":
        full_text = str(event.get("text") or "")
        if full_text:
            out.append(("agent_text", {"text": full_text, "role": "assistant", "run_id": run_id}))
        out.append(("agent_run_finished", {"state": state, "run_id": run_id, "ok": True}))
        return out

    if event_type == "error":
        out.append((
            "agent_run_finished",
            {"state": state, "run_id": run_id, "ok": False, "error": event.get("message")},
        ))
        return out

    message_type = event.get("message_type")
    if message_type == "status":
        msg = str(event.get("message") or event.get("status") or "").strip()
        if msg and msg.lower() not in _LIFECYCLE_STATUS_NOISE:
            out.append(("agent_thinking", {"message": msg, "run_id": run_id}))
    return out


async def stream_agent_prompt(
    *,
    session_id: str,
    store: Any,
    state: str,
    prompt: str,
    interaction_mode: str = "execute",
    web_search_enabled: bool = True,
) -> str:
    """Run Cursor agent, append session events, return full assistant text."""
    from api.cursor_agent import cursor_agent_service

    run_id = str(uuid.uuid4())
    text_parts: list[str] = []
    assistant_text = ""
    cancel_event = asyncio.Event()
    active_run: dict[str, Any] = {"run": None}
    register_session_agent_run(
        session_id,
        cancel_event=cancel_event,
        active_run=active_run,
        run_id=run_id,
        state=state,
    )

    session = store.get_session(session_id) or {}
    config = session.get("config") if isinstance(session.get("config"), dict) else {}
    model_id = (
        str(session.get("agent_model") or config.get("agent_model") or "").strip() or None
    )
    raw_params = session.get("agent_model_params")
    if raw_params is None:
        raw_params = config.get("agent_model_params")
    model_params = raw_params if isinstance(raw_params, list) else None

    try:
        async for event in cursor_agent_service.stream_chat(
            prompt=prompt,
            agent_id=None,
            interaction_mode=interaction_mode,
            web_search_enabled=web_search_enabled,
            trading_session=True,
            trading_session_id=session_id,
            cancel_event=cancel_event,
            active_run=active_run,
            model_id=model_id,
            model_params=model_params,
        ):
            current = store.get_session(session_id)
            if not current or current.get("state") == "stopped":
                break
            for event_type, payload in session_event_from_cursor(state, event, run_id):
                store.append_event(session_id, event_type, payload)
            if event.get("type") == "text_delta":
                text_parts.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                assistant_text = str(event.get("text") or "") or "".join(text_parts)
                if assistant_text.strip():
                    emit_surfaces_from_text(store, session_id, assistant_text)
    except asyncio.CancelledError:
        store.append_event(
            session_id,
            "agent_run_finished",
            {"state": state, "run_id": run_id, "ok": False, "error": "Cancelled"},
        )
        raise
    finally:
        clear_session_agent_run(session_id)

    return assistant_text


def emit_surfaces_from_text(store: Any, session_id: str, assistant_text: str) -> None:
    for surface in expand_agent_text_to_surfaces(assistant_text):
        normalized = _autonomous_session_surface(surface)
        if normalized:
            store.append_event(session_id, "agent_a2ui_surface", normalized)


def _autonomous_session_surface(surface: dict[str, Any]) -> dict[str, Any] | None:
    """Trading sessions auto-deploy — never surface interactive StrategySetupForm / ButtonRow."""
    components = surface.get("components") or []
    if not isinstance(components, list):
        return surface

    out: list[dict[str, Any]] = []
    for comp in components:
        if not isinstance(comp, dict):
            continue
        component = str(comp.get("component") or "")
        if component == "ButtonRow":
            continue
        if component == "StrategySetupForm":
            props = dict(comp.get("props") or {})
            out.append({
                "id": comp.get("id"),
                "component": "StrategySummary",
                "props": {
                    "symbol": str(props.get("symbol") or "").split("-")[0],
                    "entry_price": props.get("close_price"),
                    "long_percent": props.get("long_percent"),
                    "short_percent": props.get("short_percent"),
                    "capital": props.get("max_available_capital"),
                    "broker": props.get("broker"),
                    "account_env": props.get("account_env"),
                    "status": "auto-deploying",
                },
            })
            continue
        out.append(comp)

    if not out:
        return None
    return {**surface, "components": out}


from control_plane.agent_autonomous_trade import extract_autonomous_entries


def _normalize_deploy_config(
    props: dict[str, Any],
    session: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Map StrategySetupForm / StrategySummary props to deploy config."""
    symbol = str(props.get("symbol") or "").strip()
    if not symbol and session:
        symbol = str(session.get("symbol") or "").strip()
    close_price = (
        props.get("close_price")
        or props.get("entry_price")
        or props.get("entryPrice")
        or props.get("ltp")
    )
    if not symbol or close_price is None:
        return None
    try:
        price = float(close_price)
    except (TypeError, ValueError):
        return None
    if price <= 0:
        return None

    config = dict(props)
    config["symbol"] = symbol
    config["close_price"] = price
    if config.get("long_percent") is None and props.get("target_percent") is not None:
        config["long_percent"] = props.get("target_percent")
    if config.get("short_percent") is None and props.get("stop_percent") is not None:
        config["short_percent"] = props.get("stop_percent")
    if config.get("max_available_capital") is None and props.get("capital") is not None:
        config["max_available_capital"] = props.get("capital")
    return config


def _collect_session_events(store: Any, session_id: str, since_id: int = 0) -> list[dict[str, Any]]:
    return store.list_events(session_id, since_id=since_id, limit=500)


def _latest_agent_text(store: Any, session_id: str, since_id: int = 0) -> str:
    for event in reversed(_collect_session_events(store, session_id, since_id)):
        if event.get("event_type") != "agent_text":
            continue
        text = str((event.get("payload") or {}).get("text") or "").strip()
        if text:
            return text
    return ""


def _entry_price_from_events(
    store: Any,
    session_id: str,
    since_id: int = 0,
    session: dict[str, Any] | None = None,
) -> float | None:
    for event in reversed(_collect_session_events(store, session_id, since_id)):
        texts: list[str] = []
        if event.get("event_type") == "agent_text":
            text = str((event.get("payload") or {}).get("text") or "").strip()
            if text:
                texts.append(text)
        elif event.get("event_type") == "agent_a2ui_surface":
            for comp in (event.get("payload") or {}).get("components") or []:
                if not isinstance(comp, dict):
                    continue
                props = dict(comp.get("props") or {})
                config = _normalize_deploy_config(props, session)
                if config and config.get("close_price"):
                    return float(config["close_price"])
        for text in texts:
            config = parse_strategy_suggestion(text)
            if config and config.get("close_price"):
                return float(config["close_price"])
    return None


def parse_strategy_from_surface_events(
    store: Any,
    session_id: str,
    since_id: int = 0,
    session: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Read deploy config from agent_a2ui_surface and agent_text events."""
    for event in reversed(_collect_session_events(store, session_id, since_id)):
        if event.get("event_type") == "agent_text":
            text = str((event.get("payload") or {}).get("text") or "").strip()
            if not text:
                continue
            config = parse_strategy_suggestion(text)
            if config:
                return config
            for block in extract_a2ui_blocks(text):
                component = str(block.get("component") or "")
                if component not in {"StrategySetupForm", "StrategySummary"}:
                    continue
                config = _normalize_deploy_config(dict(block.get("props") or {}), session)
                if config:
                    return config
            continue

        if event.get("event_type") != "agent_a2ui_surface":
            continue
        payload = event.get("payload") or {}
        components = payload.get("components") or []
        if not isinstance(components, list):
            continue
        for comp in components:
            if not isinstance(comp, dict):
                continue
            component = str(comp.get("component") or "")
            if component not in {"StrategySetupForm", "StrategySummary"}:
                continue
            config = _normalize_deploy_config(dict(comp.get("props") or {}), session)
            if config:
                return config
    return None


def parse_strategy_suggestion(assistant_text: str, session: dict[str, Any] | None = None) -> dict[str, Any] | None:
    for action in extract_actions_from_assistant_text(assistant_text):
        action_type = str(action.get("type") or "").lower()
        if action_type in {"strategy_suggestion", "strategy"}:
            body = dict(action.get("payload") or {})
            for key in ("symbol", "token", "exchange", "broker", "account_env"):
                if action.get(key) is not None and body.get(key) is None:
                    body[key] = action.get(key)
            normalized = _normalize_deploy_config(body, session)
            return normalized or body

    for block in extract_a2ui_blocks(assistant_text):
        component = str(block.get("component") or "")
        if component not in {"StrategySetupForm", "StrategySummary"}:
            continue
        props = dict(block.get("props") or {})
        config = _normalize_deploy_config(props, session)
        if config:
            return config

    entries = extract_autonomous_entries(assistant_text)
    if entries:
        body = entries[0]
        return {
            "symbol": body.get("symbol"),
            "token": body.get("token"),
            "exchange": body.get("exchange"),
            "broker": body.get("broker"),
            "account_env": body.get("account_env"),
            "close_price": body.get("close_price") or body.get("entry_price"),
            "long_percent": body.get("long_percent"),
            "short_percent": body.get("short_percent"),
            "initial_threshold": body.get("initial_threshold"),
            "max_available_capital": body.get("max_available_capital"),
        }

    return None


def _trade_decision_confidence(
    assistant_text: str,
    store: Any,
    session_id: str,
    since_id: int = 0,
) -> float:
    best = 0.0
    for block in extract_a2ui_blocks(assistant_text):
        if block.get("component") != "TradeDecision":
            continue
        props = block.get("props") or {}
        try:
            best = max(best, float(props.get("confidence_pct") or 0))
        except (TypeError, ValueError):
            continue

    events = store.list_events(session_id, since_id=since_id, limit=500)
    for event in reversed(events):
        if event.get("event_type") != "agent_a2ui_surface":
            continue
        for comp in (event.get("payload") or {}).get("components") or []:
            if not isinstance(comp, dict) or comp.get("component") != "TradeDecision":
                continue
            props = comp.get("props") or {}
            try:
                best = max(best, float(props.get("confidence_pct") or 0))
            except (TypeError, ValueError):
                continue
    return best


async def synthesize_strategy_from_session_ltp(
    session: dict[str, Any],
    *,
    entry_price: float | None = None,
) -> dict[str, Any] | None:
    """Build deploy config from session goals + live LTP when agent emits TradeDecision only."""
    symbol = str(session.get("symbol") or "").strip()
    token = str(session.get("token") or "").strip()
    if not symbol or not token:
        return None

    broker = str(session.get("broker") or "etoro").lower()
    account_env = str(session.get("account_env") or "demo").lower()
    max_capital = float(session.get("max_capital") or 5000)
    profit_target = float(session.get("profit_target") or 0)
    long_pct = round((profit_target / max_capital * 100), 2) if max_capital > 0 and profit_target > 0 else 2.0
    short_pct = max(1.0, round(long_pct / 2, 2))

    close_price = entry_price
    if close_price is None and broker == "etoro":
        try:
            from brokers.etoro.candles import CANDLE_INTERVAL_ONE_MINUTE, aget_historical_candles

            candles = await aget_historical_candles(
                symbol=symbol,
                token=token,
                exchange=str(session.get("exchange") or "ETORO"),
                account_env=account_env,
                interval=CANDLE_INTERVAL_ONE_MINUTE,
                count=5,
            )
            if candles:
                last = candles[-1]
                raw = last.get("close") or last.get("Close") or last.get("c")
                if raw is not None:
                    close_price = float(raw)
        except Exception:
            log.exception("[TRADING_SESSION] LTP fetch failed symbol=%s", symbol)

    if close_price is None or close_price <= 0:
        return None

    return {
        "symbol": symbol,
        "token": token,
        "exchange": session.get("exchange") or "ETORO",
        "broker": broker,
        "account_env": account_env,
        "close_price": close_price,
        "long_percent": long_pct,
        "short_percent": short_pct,
        "initial_threshold": 0.2,
        "max_available_capital": max_capital,
        "synthesized": True,
    }


async def resolve_strategy_config(
    *,
    session: dict[str, Any],
    assistant_text: str,
    store: Any,
    session_id: str,
    since_id: int = 0,
    min_trade_decision_confidence: float = 50.0,
) -> dict[str, Any] | None:
    text = assistant_text.strip() or _latest_agent_text(store, session_id, since_id)

    config = parse_strategy_suggestion(text, session)
    if config:
        return config

    config = parse_strategy_from_surface_events(store, session_id, since_id=since_id, session=session)
    if config:
        return config

    entry_hint = _entry_price_from_events(store, session_id, since_id=since_id, session=session)
    confidence = _trade_decision_confidence(text, store, session_id, since_id=since_id)

    if confidence >= min_trade_decision_confidence or entry_hint is not None:
        synthesized = await synthesize_strategy_from_session_ltp(session, entry_price=entry_hint)
        if synthesized:
            store.append_event(
                session_id,
                "strategy_synthesized",
                {
                    "confidence_pct": confidence,
                    "close_price": synthesized.get("close_price"),
                    "entry_hint": entry_hint,
                },
            )
            return synthesized

    # Last resort: session has symbol+token — deploy with live LTP and session goal defaults.
    if session.get("symbol") and session.get("token"):
        synthesized = await synthesize_strategy_from_session_ltp(session, entry_price=entry_hint)
        if synthesized:
            store.append_event(
                session_id,
                "strategy_synthesized",
                {"close_price": synthesized.get("close_price"), "fallback": "session_defaults"},
            )
            return synthesized

    return None


def schedule_phase_task(
    key: str,
    coro_factory: Callable[[], Any],
) -> None:
    existing = _phase_tasks.get(key)
    if existing and not existing.done():
        return

    async def _wrapper() -> None:
        lock = _phase_locks.setdefault(key, asyncio.Lock())
        async with lock:
            await coro_factory()

    try:
        loop = asyncio.get_running_loop()
        _phase_tasks[key] = loop.create_task(_wrapper())
    except RuntimeError:
        log.warning("[TRADING_SESSION] no event loop to schedule task %s", key)


def cancel_phase_task(key: str, *, skip_current: bool = False) -> None:
    task = _phase_tasks.get(key)
    if not task or task.done():
        _phase_tasks.pop(key, None)
        return
    if skip_current:
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if task is current:
            return
    _phase_tasks.pop(key, None)
    task.cancel()


def cancel_all_session_tasks(session_id: str, *, skip_current: bool = False) -> None:
    for prefix in ("explore", "research", "strategy", "monitor"):
        cancel_phase_task(f"{session_id}:{prefix}", skip_current=skip_current)
