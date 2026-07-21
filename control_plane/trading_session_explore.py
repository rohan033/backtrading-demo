from __future__ import annotations

import logging
from typing import Any

from api.a2ui_bridge import component_to_surface, extract_a2ui_blocks

from control_plane.trading_session_agent_common import (
    _latest_agent_text,
    cancel_phase_task,
    emit_surfaces_from_text,
    schedule_phase_task,
    stream_agent_prompt,
)
from control_plane.trading_session_deterministic import deterministic_explore_picks
from control_plane.trading_session_prompts import (
    trading_session_prompt_prefix,
    trading_session_profit_target_block,
    trading_session_user_instruction_block,
    wrap_trading_session_prompt,
)
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

_EXPLORE_TASK_KEY = "explore"


def build_explore_kickoff_prompt(session: dict[str, Any], store: TradingSessionStore, session_id: str) -> str:
    goals = trading_session_profit_target_block(session)
    user_note = trading_session_user_instruction_block(store, session_id)
    body = f"""{trading_session_prompt_prefix(session)}

Autonomous trading session — EXPLORE (stock discovery).

{goals}
{user_note}

Broker: {session.get("broker")} ({session.get("account_env")})
No symbol pre-selected — find the best stock to trade for these goals.

Instructions:
1. Shortlist 3–5 symbols via search_instruments (broker={session.get("broker")}, account_env={session.get("account_env")}, exchange=ETORO for eToro), then narrow to exactly 3 finalists.
   Prefer any search hit with from_watchlist=true — reuse that instrument token/tradingsymbol.
2. For EACH finalist, BEFORE writing any debate or pick:
   - get_historical_candles (1m or 5m + 30m/4h)
   - get_company_news and get_recommendation_trends
3. Emit CandidateDebate then TopStockPicks with exactly 3 ranked candidates.
   Each pick MUST include: symbol, name, token, exchange from search_instruments (watchlist token when present).
4. Do NOT emit StrategySetupForm or place orders — discovery only.

The system will auto-select your #1 ranked pick (server fallback if picks are missing).

Example TopStockPicks fence:
```json
{{"a2ui":{{"component":"TopStockPicks","props":{{"picks":[{{"symbol":"NVDA","name":"NVIDIA","token":"1111","exchange":"ETORO","recommendation":"+3.2% in 4h"}}]}}}}}}
```
"""
    return wrap_trading_session_prompt(store, session_id, body)


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


def _parse_picks_from_events(store: TradingSessionStore, session_id: str, since_id: int) -> list[dict[str, Any]]:
    for event in reversed(store.list_events(session_id, since_id=since_id, limit=500)):
        if event.get("event_type") == "agent_picks":
            raw = (event.get("payload") or {}).get("picks") or []
            picks = [p for p in raw if isinstance(p, dict) and p.get("symbol")]
            if picks:
                return picks
        if event.get("event_type") != "agent_a2ui_surface":
            continue
        for comp in (event.get("payload") or {}).get("components") or []:
            if not isinstance(comp, dict) or comp.get("component") != "TopStockPicks":
                continue
            props = comp.get("props") or {}
            picks = [p for p in (props.get("picks") or []) if isinstance(p, dict) and p.get("symbol")]
            if picks:
                return picks
    return []


async def _apply_explore_picks(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
    all_picks: list[dict[str, Any]],
    *,
    source: str,
    assistant_text: str = "",
) -> None:
    if assistant_text.strip():
        emit_surfaces_from_text(store, session_id, assistant_text)
    elif all_picks:
        store.append_event(
            session_id,
            "agent_a2ui_surface",
            component_to_surface(
                "TopStockPicks",
                {"picks": all_picks[:3], "showCharts": False},
            ),
        )

    store.append_event(session_id, "agent_picks", {"picks": all_picks[:3], "source": source})
    pick = all_picks[0]
    symbol = str(pick.get("symbol") or "").strip()
    token = str(pick.get("token") or "").strip()
    exchange = str(pick.get("exchange") or "").strip() or None

    session = store.get_session(session_id) or {}
    broker = str(session.get("broker") or "etoro").lower()
    account_env = str(session.get("account_env") or "demo").lower()
    from control_plane.instrument_resolve import find_watchlist_instrument

    watchlist_hit = find_watchlist_instrument(broker, account_env, symbol)
    if watchlist_hit:
        wl_token = str(watchlist_hit.get("symboltoken") or "").strip()
        wl_symbol = str(watchlist_hit.get("tradingsymbol") or symbol).strip()
        if wl_token:
            if wl_token != token:
                store.append_event(
                    session_id,
                    "watchlist_token_override",
                    {
                        "symbol": wl_symbol,
                        "previous_token": token,
                        "token": wl_token,
                        "watchlist_name": watchlist_hit.get("watchlist_name"),
                    },
                )
            symbol = wl_symbol
            token = wl_token
            exchange = str(watchlist_hit.get("exchange") or exchange or "ETORO")

    store.append_event(
        session_id,
        "top_pick_selected",
        {"symbol": symbol, "token": token, "exchange": exchange, "source": source},
    )
    store.append_event(
        session_id,
        "symbol_resolved",
        {"symbol": symbol, "token": token, "exchange": exchange},
    )

    await engine.transition_session(
        session_id,
        to_state="research",
        reason=f"Explore complete ({source})",
        patch={"symbol": symbol, "token": token, "exchange": exchange},
    )


async def run_agent_explore(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    session = store.get_session(session_id)
    if not session or session.get("state") != "explore":
        return

    started = store.append_event(session_id, "agent_explore_started", {"state": "explore"})
    since_id = int(started.get("id") or 0)
    prompt = build_explore_kickoff_prompt(session, store, session_id)

    try:
        assistant_text = await stream_agent_prompt(
            session_id=session_id,
            store=store,
            state="explore",
            prompt=prompt,
        )

        session = store.get_session(session_id) or session
        if session.get("state") == "stopped":
            return

        text = assistant_text.strip() or _latest_agent_text(store, session_id, since_id)
        all_picks = parse_top_stock_picks(text) or _parse_picks_from_events(store, session_id, since_id)

        if not all_picks:
            store.append_event(session_id, "explore_deterministic_fallback", {"reason": "no agent picks"})
            all_picks = await deterministic_explore_picks(session)

        if not all_picks:
            await engine.stop_session(session_id, "Explore failed: no tradable symbols found", skip_task_cancel=True)
            return

        await _apply_explore_picks(
            session_id,
            store,
            engine,
            all_picks,
            source="agent" if parse_top_stock_picks(text) else "deterministic",
            assistant_text=text,
        )
    except Exception as exc:
        log.exception("[TRADING_SESSION] explore failed session=%s", session_id)
        session = store.get_session(session_id) or session
        if session.get("state") == "stopped":
            return
        try:
            all_picks = await deterministic_explore_picks(session)
            if all_picks:
                store.append_event(session_id, "explore_deterministic_fallback", {"reason": str(exc)})
                await _apply_explore_picks(session_id, store, engine, all_picks, source="deterministic")
                return
        except Exception:
            log.exception("[TRADING_SESSION] deterministic explore fallback failed session=%s", session_id)
        store.append_event(session_id, "agent_explore_failed", {"reason": str(exc)})
        await engine.stop_session(session_id, f"Explore error: {exc}", skip_task_cancel=True)


def schedule_explore_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    schedule_phase_task(
        f"{session_id}:{_EXPLORE_TASK_KEY}",
        lambda: run_agent_explore(session_id, store, engine),
    )


def cancel_explore_agent(session_id: str, *, skip_current: bool = False) -> None:
    cancel_phase_task(f"{session_id}:{_EXPLORE_TASK_KEY}", skip_current=skip_current)
