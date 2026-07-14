from __future__ import annotations

import logging
from typing import Any

from control_plane.trading_session_agent_common import (
    schedule_phase_task,
    stream_agent_prompt,
)
from control_plane.trading_session_prompts import (
    trading_session_prompt_prefix,
    trading_session_profit_target_block,
    trading_session_user_instruction_block,
    wrap_trading_session_prompt,
)
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")


def build_research_kickoff_prompt(session: dict[str, Any], store: TradingSessionStore, session_id: str) -> str:
    symbol = session.get("symbol") or "the selected symbol"
    goals = trading_session_profit_target_block(session)
    user_note = trading_session_user_instruction_block(store, session_id)
    body = f"""{trading_session_prompt_prefix(session)}

Autonomous trading session — RESEARCH (deep dive on selected symbol).

{goals}
{user_note}

Symbol: {symbol} (token={session.get("token")}, exchange={session.get("exchange")})
Broker: {session.get("broker")} ({session.get("account_env")})

Instructions:
1. Fetch get_historical_candles (1m/5m + 30m/4h) for {symbol} FIRST — compute 1h, 4h, and session $/% changes.
2. get_company_news, get_recommendation_trends, web search for catalysts — reconcile with candle direction (do not contradict recent price action).
3. DOUBLE-CHECK: profit target feasibility vs actual recent range from candles before any A2UI.
4. Emit CandidateDebate, InsightCards (via ai_summary), and TradeDecision with confidence_pct grounded in candle facts.
5. Do NOT emit StrategySetupForm or place orders — research only.

Example TradeDecision fence:
```json
{{"a2ui":{{"component":"TradeDecision","props":{{"text":"Bullish momentum intact","confidence_pct":72,"symbol":"{symbol}"}}}}}}
```
"""
    return wrap_trading_session_prompt(store, session_id, body)


async def run_agent_research(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    session = store.get_session(session_id)
    if not session or session.get("state") != "research":
        return

    if not session.get("symbol"):
        await engine.stop_session(session_id, "Research skipped: no symbol", skip_task_cancel=True)
        return

    store.append_event(session_id, "agent_research_started", {"state": "research"})
    prompt = build_research_kickoff_prompt(session, store, session_id)

    try:
        assistant_text = await stream_agent_prompt(
            session_id=session_id,
            store=store,
            state="research",
            prompt=prompt,
        )

        await engine.transition_session(
            session_id,
            to_state="strategy",
            reason="Research complete",
        )
    except Exception as exc:
        log.exception("[TRADING_SESSION] research agent failed session=%s", session_id)
        store.append_event(session_id, "agent_research_failed", {"reason": str(exc)})
        session = store.get_session(session_id) or session
        if session.get("state") == "stopped":
            return
        await engine.transition_session(
            session_id,
            to_state="strategy",
            reason="Research incomplete — continuing with deterministic deploy",
        )


def schedule_research_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    schedule_phase_task(
        f"{session_id}:research",
        lambda: run_agent_research(session_id, store, engine),
    )
