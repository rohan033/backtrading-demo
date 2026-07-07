from __future__ import annotations

import logging
from typing import Any

from control_plane.trading_session_agent_common import (
    emit_surfaces_from_text,
    parse_strategy_suggestion,
    schedule_phase_task,
    stream_agent_prompt,
)
from control_plane.trading_session_prompts import trading_session_prompt_prefix, trading_session_profit_target_block
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")


def build_strategy_kickoff_prompt(session: dict[str, Any]) -> str:
    symbol = session.get("symbol") or "the selected symbol"
    goals = trading_session_profit_target_block(session)
    return f"""{trading_session_prompt_prefix()}

Autonomous trading session — STRATEGY (setup parameters for deploy).

{goals}

Symbol: {symbol} (token={session.get("token")}, exchange={session.get("exchange")})
Broker: {session.get("broker")} ({session.get("account_env")})

Instructions:
1. Call get_historical_candles for {symbol} — use the latest close as close_price (not stale quotes).
2. DOUBLE-CHECK: long_percent / short_percent align with recent candle range and profit target math before emitting strategy_suggestion.
3. Emit ai_action strategy_suggestion with deploy parameters from live candle LTP.
   Required payload fields: symbol, token, exchange, broker, account_env, close_price,
   long_percent, short_percent, initial_threshold, max_available_capital.
4. Also emit StrategySummary props preview and TradeDecision with confidence_pct.
5. Do NOT place orders — the server deploys automatically from your strategy_suggestion.

Example:
```json
{{"ai_action":{{"type":"strategy_suggestion","title":"{symbol} momentum","payload":{{
  "symbol":"{symbol}","token":"{session.get("token")}","exchange":"{session.get("exchange") or "ETORO"}",
  "broker":"{session.get("broker")}","account_env":"{session.get("account_env")}",
  "close_price":100.0,"long_percent":2,"short_percent":1,"initial_threshold":0.2,
  "max_available_capital":{session.get("max_capital")}
}}}}}}
```
"""


async def run_agent_strategy(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    session = store.get_session(session_id)
    if not session or session.get("state") != "strategy":
        return

    if not session.get("symbol") or not session.get("token"):
        await engine.stop_session(session_id, "Strategy skipped: missing symbol/token", skip_task_cancel=True)
        return

    store.append_event(session_id, "agent_strategy_started", {"state": "strategy"})
    prompt = build_strategy_kickoff_prompt(session)

    try:
        assistant_text = await stream_agent_prompt(
            session_id=session_id,
            store=store,
            state="strategy",
            prompt=prompt,
        )
        emit_surfaces_from_text(store, session_id, assistant_text)

        config = parse_strategy_suggestion(assistant_text)
        if not config:
            store.append_event(session_id, "agent_strategy_failed", {"reason": "No strategy_suggestion in response"})
            await engine.stop_session(session_id, "Strategy agent did not return setup parameters", skip_task_cancel=True)
            return

        config.setdefault("symbol", session.get("symbol"))
        config.setdefault("token", session.get("token"))
        config.setdefault("exchange", session.get("exchange"))
        config.setdefault("broker", session.get("broker"))
        config.setdefault("account_env", session.get("account_env"))
        config.setdefault("max_available_capital", session.get("max_capital"))

        store.append_event(session_id, "strategy_config", {"config": config})

        await engine.transition_session(
            session_id,
            to_state="deploy",
            reason="Strategy parameters ready",
            patch={"strategy_type": "momentum"},
        )
    except Exception as exc:
        log.exception("[TRADING_SESSION] strategy agent failed session=%s", session_id)
        store.append_event(session_id, "agent_strategy_failed", {"reason": str(exc)})
        await engine.stop_session(session_id, f"Strategy error: {exc}", skip_task_cancel=True)


def schedule_strategy_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    schedule_phase_task(
        f"{session_id}:strategy",
        lambda: run_agent_strategy(session_id, store, engine),
    )
