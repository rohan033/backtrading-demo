from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from api.a2ui_bridge import component_to_surface, extract_a2ui_blocks, tool_log_surface

from control_plane.trading_session_handlers import (
    HandlerContext,
    PHASE1_STOP_REASON,
    Transition,
)
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

_explore_tasks: dict[str, asyncio.Task] = {}
_explore_locks: dict[str, asyncio.Lock] = {}


def build_explore_kickoff_prompt(session: dict[str, Any]) -> str:
    return f"""Autonomous trading session — EXPLORE (stock discovery).

Goals:
- Broker: {session.get("broker")} ({session.get("account_env")})
- Account: {session.get("account_env")} (demo or live)
- Max capital: {session.get("max_capital")}
- Profit target: {session.get("profit_target")}
- No symbol pre-selected — find the best stock to trade for these goals.

Instructions:
1. Research silently with search_instruments, get_company_news, get_recommendation_trends, and web search.
2. Emit CandidateDebate then TopStockPicks with exactly 3 ranked candidates.
   Each pick MUST include: symbol, name, token, exchange from search_instruments, and a one-line recommendation tied to the capital/profit goal.
3. Do NOT emit StrategySetupForm or place orders — discovery only.

The system will auto-select your #1 ranked pick.

Example TopStockPicks fence:
```json
{{"a2ui":{{"component":"TopStockPicks","props":{{"picks":[{{"symbol":"NVDA","name":"NVIDIA","token":"1111","exchange":"ETORO","recommendation":"Best R/R on $5k capital."}}]}}}}}}
```
"""


def parse_top_stock_picks(assistant_text: str) -> list[dict[str, Any]]:
    for block in extract_a2ui_blocks(assistant_text):
        if block.get("component") != "TopStockPicks":
            continue
        props = block.get("props") or {}
        picks = props.get("picks") or []
        return [pick for pick in picks if isinstance(pick, dict) and pick.get("symbol")]
    return []


def parse_top_stock_pick(assistant_text: str) -> dict[str, Any] | None:
    picks = parse_top_stock_picks(assistant_text)
    return picks[0] if picks else None


def _session_event_from_cursor(session_id: str, event: dict[str, Any], run_id: str) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    event_type = event.get("type")

    if event_type == "start":
        out.append(("agent_run_started", {"state": "explore", "run_id": run_id}))
        return out

    if event_type == "tool_call":
        tool_log = tool_log_surface(event)
        if tool_log:
            props = tool_log.get("props") or {}
            out.append((
                "agent_tool_call",
                {
                    "tool_name": props.get("toolName") or props.get("tool_name") or event.get("tool_name"),
                    "tool_status": props.get("status") or event.get("tool_status"),
                    "detail": props.get("detail") or "",
                    "run_id": run_id,
                },
            ))
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
        out.append(("agent_run_finished", {"state": "explore", "run_id": run_id, "ok": True}))
        return out

    if event_type == "error":
        out.append((
            "agent_run_finished",
            {"state": "explore", "run_id": run_id, "ok": False, "error": event.get("message")},
        ))
        return out

    message_type = event.get("message_type")
    if message_type == "status":
        msg = str(event.get("message") or event.get("status") or "").strip()
        if msg:
            out.append(("agent_thinking", {"message": msg, "run_id": run_id}))
    return out


async def run_agent_explore(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    session = store.get_session(session_id)
    if not session or session.get("state") != "explore":
        return

    run_id = str(uuid.uuid4())
    prompt = build_explore_kickoff_prompt(session)
    assistant_text = ""
    text_parts: list[str] = []

    from api.cursor_agent import cursor_agent_service

    try:
        async for event in cursor_agent_service.stream_chat(
            prompt=prompt,
            agent_id=None,
            interaction_mode="execute",
            web_search_enabled=True,
        ):
            for event_type, payload in _session_event_from_cursor(session_id, event, run_id):
                store.append_event(session_id, event_type, payload)
            if event.get("type") == "text_delta":
                text_parts.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                assistant_text = str(event.get("text") or "") or "".join(text_parts)

        all_picks = parse_top_stock_picks(assistant_text)
        if not all_picks:
            store.append_event(session_id, "agent_explore_failed", {"reason": "No TopStockPicks in agent response"})
            await engine.stop_session(session_id, "Agent explore failed: no stock picks returned")
            return

        for block in extract_a2ui_blocks(assistant_text):
            component = block.get("component")
            if component not in ("CandidateDebate", "TopStockPicks"):
                continue
            props = dict(block.get("props") or {})
            if component == "TopStockPicks":
                props["picks"] = all_picks
                props.setdefault("showCharts", False)
            store.append_event(
                session_id,
                "agent_a2ui_surface",
                component_to_surface(str(component), props),
            )

        store.append_event(session_id, "agent_picks", {"picks": all_picks})
        pick = all_picks[0]
        symbol = str(pick.get("symbol") or "").strip()
        token = str(pick.get("token") or "").strip()
        exchange = str(pick.get("exchange") or "").strip() or None

        store.append_event(
            session_id,
            "top_pick_selected",
            {"symbol": symbol, "token": token, "exchange": exchange, "recommendation": pick.get("recommendation")},
        )
        store.append_event(
            session_id,
            "symbol_resolved",
            {"symbol": symbol, "token": token, "exchange": exchange},
        )

        await engine.transition_session(
            session_id,
            to_state="stopped",
            reason=PHASE1_STOP_REASON,
            patch={"symbol": symbol, "token": token, "exchange": exchange},
        )
    except asyncio.CancelledError:
        store.append_event(session_id, "agent_explore_failed", {"reason": "Cancelled"})
        raise
    except Exception as exc:
        log.exception("[TRADING_SESSION] explore agent failed session=%s", session_id)
        store.append_event(session_id, "agent_explore_failed", {"reason": str(exc)})
        await engine.stop_session(session_id, f"Agent explore error: {exc}")
    finally:
        _explore_tasks.pop(session_id, None)


def schedule_explore_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    existing = _explore_tasks.get(session_id)
    if existing and not existing.done():
        return

    async def _runner() -> None:
        lock = _explore_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            await run_agent_explore(session_id, store, engine)

    try:
        loop = asyncio.get_running_loop()
        _explore_tasks[session_id] = loop.create_task(_runner())
    except RuntimeError:
        log.warning("[TRADING_SESSION] no event loop to schedule explore for %s", session_id)


def cancel_explore_agent(session_id: str) -> None:
    task = _explore_tasks.pop(session_id, None)
    if task and not task.done():
        task.cancel()
