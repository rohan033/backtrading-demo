from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from api.a2ui_bridge import component_to_surface, extract_a2ui_blocks

from control_plane.trading_session_agent_common import (
    cancel_phase_task,
    clear_session_agent_run,
    register_session_agent_run,
    schedule_phase_task,
    session_event_from_cursor,
)
from control_plane.trading_session_handlers import (
    HandlerContext,
    Transition,
)
from control_plane.trading_session_prompts import trading_session_prompt_prefix, trading_session_profit_target_block
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

_EXPLORE_TASK_KEY = "explore"


def build_explore_kickoff_prompt(session: dict[str, Any]) -> str:
    goals = trading_session_profit_target_block(session)
    return f"""{trading_session_prompt_prefix()}

Autonomous trading session — EXPLORE (stock discovery).

{goals}

Broker: {session.get("broker")} ({session.get("account_env")})
No symbol pre-selected — find the best stock to trade for these goals.

Instructions:
1. Shortlist 3–5 symbols via search_instruments, then narrow to exactly 3 finalists.
2. For EACH finalist, BEFORE writing any debate or pick:
   - get_historical_candles (1m or 5m + 30m/4h)
   - get_company_news and get_recommendation_trends
   - web search for same-day catalysts only when candles/news gap exists
3. Run the DOUBLE-CHECK pass: every symbol's recent $/% move from candles must match your narrative. Do not describe a selloff if candles show a spike (or vice versa).
4. Rank by risk/reward FOR THIS SESSION'S profit target using actual recent volatility from candles — not generic analyst themes alone.
5. Emit CandidateDebate then TopStockPicks with exactly 3 ranked candidates.
   Each pick MUST include: symbol, name, token, exchange from search_instruments, and a one-line recommendation citing recent candle move + why profit target is feasible.
6. Do NOT emit StrategySetupForm or place orders — discovery only.

The system will auto-select your #1 ranked pick.

Example TopStockPicks fence:
```json
{{"a2ui":{{"component":"TopStockPicks","props":{{"picks":[{{"symbol":"NVDA","name":"NVIDIA","token":"1111","exchange":"ETORO","recommendation":"+3.2% in 4h; 2% target fits recent range on $5k."}}]}}}}}}
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
    run_finished = False
    run_error: str | None = None
    cancel_event = asyncio.Event()
    active_run: dict[str, Any] = {"run": None}

    from api.cursor_agent import cursor_agent_service

    register_session_agent_run(
        session_id,
        cancel_event=cancel_event,
        active_run=active_run,
        run_id=run_id,
        state="explore",
    )

    try:
        async for event in cursor_agent_service.stream_chat(
            prompt=prompt,
            agent_id=None,
            interaction_mode="execute",
            web_search_enabled=True,
            trading_session=True,
            cancel_event=cancel_event,
            active_run=active_run,
        ):
            current = store.get_session(session_id)
            if not current or current.get("state") == "stopped":
                break

            for event_type, payload in session_event_from_cursor("explore", event, run_id):
                store.append_event(session_id, event_type, payload)
                if event_type == "agent_run_finished":
                    run_finished = True
                    if not payload.get("ok"):
                        run_error = str(payload.get("error") or "").strip() or None
            if event.get("type") == "text_delta":
                text_parts.append(str(event.get("text") or ""))
            if event.get("type") == "done":
                assistant_text = str(event.get("text") or "") or "".join(text_parts)

        current = store.get_session(session_id)
        if not current or current.get("state") == "stopped":
            return

        all_picks = parse_top_stock_picks(assistant_text)
        if not all_picks:
            if not run_finished:
                store.append_event(
                    session_id,
                    "agent_run_finished",
                    {"state": "explore", "run_id": run_id, "ok": False, "error": "No stock picks returned"},
                )
            fail_detail = run_error or "No TopStockPicks in agent response"
            stop_reason = run_error or "Agent explore failed: no stock picks returned"
            store.append_event(session_id, "agent_explore_failed", {"reason": fail_detail})
            await engine.stop_session(session_id, stop_reason, skip_task_cancel=True)
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
            to_state="research",
            reason="Explore complete — starting research",
            patch={"symbol": symbol, "token": token, "exchange": exchange},
        )
    except asyncio.CancelledError:
        store.append_event(
            session_id,
            "agent_run_finished",
            {"state": "explore", "run_id": run_id, "ok": False, "error": "Cancelled"},
        )
        store.append_event(session_id, "agent_explore_failed", {"reason": "Cancelled"})
        raise
    except Exception as exc:
        log.exception("[TRADING_SESSION] explore agent failed session=%s", session_id)
        if not run_finished:
            store.append_event(
                session_id,
                "agent_run_finished",
                {"state": "explore", "run_id": run_id, "ok": False, "error": str(exc)},
            )
        store.append_event(session_id, "agent_explore_failed", {"reason": str(exc)})
        await engine.stop_session(session_id, f"Agent explore error: {exc}", skip_task_cancel=True)
    finally:
        clear_session_agent_run(session_id)


def schedule_explore_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    schedule_phase_task(
        f"{session_id}:{_EXPLORE_TASK_KEY}",
        lambda: run_agent_explore(session_id, store, engine),
    )


def cancel_explore_agent(session_id: str, *, skip_current: bool = False) -> None:
    cancel_phase_task(f"{session_id}:{_EXPLORE_TASK_KEY}", skip_current=skip_current)
