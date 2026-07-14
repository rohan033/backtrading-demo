"""Prompt fragments and tool classification for autonomous trading sessions."""

from __future__ import annotations

import json
from typing import Any

TRADING_SESSION_DATA_GUIDANCE = """DATA SOURCES (trading session):
- Prefer live market data over repo code: MCP tools (search_instruments, get_company_news, get_recommendation_trends, get_historical_candles, get_etoro_positions, etc.) and web search.
- Tool progress is logged separately — never narrate tools in chat prose."""

TRADING_SESSION_CANDLE_VERIFICATION = """CANDLE & PRICE VERIFICATION (mandatory — source of truth):
Before ANY final thesis, ranking, or A2UI output you MUST ground claims in live MCP data:

1) For EVERY finalist symbol (all 3 picks in explore; the selected symbol in later phases):
   - Call get_historical_candles for at least two windows: recent intraday (1m or 5m, last 60–120 bars) AND session context (30m or 4h, last 24–48 bars).
   - Record from the candle data: last close/LTP, high/low over 1h, 4h, and session; $ change and % change for each window.
   - Do NOT rely on stale news, "last week", or memory if candles show the opposite (e.g. do not call a "sharp selloff" when the last few hours show a large rally).

2) Profit-target feasibility (required math):
   - Required move % = (profit_target / max_capital) × 100.
   - Compare that required % to the ACTUAL recent range from candles (e.g. 4h high−low, 1h move).
   - If a symbol moved more than the profit target % in the last few hours, say so explicitly and explain whether chasing or fading is appropriate — do not ignore large recent moves.

3) DOUBLE-CHECK pass (before emitting CandidateDebate, TopStockPicks, TradeDecision, or strategy_suggestion):
   - Re-read your draft conclusions against the latest candle fetches.
   - For each symbol, verify: (a) direction of recent price action matches your narrative, (b) magnitude you cite is within what candles show, (c) profit target is achievable or risky given recent volatility.
   - If any claim fails verification, revise the draft and re-check until consistent.

4) In CandidateDebate and recommendations, cite concrete candle facts (e.g. "+8% in 4h to $1037", "1h range $12") — not vague "momentum" or outdated selloff language unless candles confirm it."""


def trading_session_broker_block(session: dict[str, Any]) -> str:
    broker = str(session.get("broker") or "etoro").lower()
    account_env = str(session.get("account_env") or "demo").lower()

    if broker == "etoro":
        return f"""BROKER SCOPE (critical — this session is eToro / {account_env}):
- Use ONLY eToro-tradable US/global symbols. Every MCP market call MUST pass broker=etoro and account_env={account_env}.
- search_instruments: use broker=etoro, exchange=ETORO (or omit exchange). NEVER pass exchange=NSE, BSE, or any Indian exchange.
- Do NOT call search_scrip, Angel One APIs, SmartConnect, or any India/NSE-specific search or candle tools.
- Reject NSE/India results entirely (e.g. AMDIND-EQ, *-EQ on NSE) — if you see them, re-search on eToro for the US ticker (e.g. AMD on ETORO).
- TopStockPicks and strategy_suggestion must use symbol, token, and exchange from eToro search_instruments results only."""

    if broker in {"angel", "angelone"}:
        return f"""BROKER SCOPE (critical — this session is Angel One / {account_env}):
- Use Angel/NSE instruments only. search_instruments with broker=angel and exchange=NSE.
- Do NOT use eToro APIs, ETORO exchange, or US eToro instrument tokens for this session."""

    return (
        f"BROKER SCOPE: session broker={broker}, account_env={account_env}. "
        "Pass matching broker and exchange on every search_instruments and get_historical_candles call."
    )


def trading_session_prompt_prefix(session: dict[str, Any] | None = None) -> str:
    parts = [TRADING_SESSION_DATA_GUIDANCE, TRADING_SESSION_CANDLE_VERIFICATION]
    if session:
        parts.append(trading_session_broker_block(session))
    return "\n\n".join(parts)


def trading_session_profit_target_block(session: dict[str, Any]) -> str:
    max_capital = float(session.get("max_capital") or 0)
    profit_target = float(session.get("profit_target") or 0)
    required_pct = (profit_target / max_capital * 100) if max_capital > 0 else 0
    return (
        f"Session goals: max_capital=${max_capital:,.0f}, profit_target=${profit_target:,.0f} "
        f"(requires ~{required_pct:.2f}% move on deployed capital). "
        "Verify this is realistic using get_historical_candles before final output."
    )


def latest_user_instruction(store: Any, session_id: str) -> str | None:
    events = store.list_events(session_id, since_id=0, limit=500)
    for event in reversed(events):
        if event.get("event_type") != "user_instruction":
            continue
        prompt = str((event.get("payload") or {}).get("prompt") or "").strip()
        if prompt:
            return prompt
    return None


def trading_session_user_instruction_block(store: Any, session_id: str) -> str:
    note = latest_user_instruction(store, session_id)
    if not note:
        return ""
    return f"USER INSTRUCTION (must follow):\n{note}"


def trading_session_context_block(store: Any, session_id: str) -> str:
    session = store.get_session(session_id) if store else None
    if not session:
        return f"TRADING SESSION ID: {session_id}"

    payload = {
        "session_id": session_id,
        "state": session.get("state"),
        "broker": session.get("broker"),
        "account_env": session.get("account_env"),
        "symbol": session.get("symbol"),
        "token": session.get("token"),
        "exchange": session.get("exchange"),
        "max_capital": session.get("max_capital"),
        "profit_target": session.get("profit_target"),
        "total_pnl": session.get("total_pnl"),
        "engine_id": session.get("engine_id"),
        "stopped_reason": session.get("stopped_reason"),
        "strategy_type": session.get("strategy_type"),
    }
    return (
        f"TRADING SESSION CONTEXT (authoritative — always use session_id={session_id} "
        f'for source_meta_id on MCP executions):\n```json\n{json.dumps(payload, indent=2, default=str)}\n```'
    )


def wrap_trading_session_prompt(store: Any, session_id: str, body: str) -> str:
    ctx = trading_session_context_block(store, session_id)
    return f"{ctx}\n\n{body.strip()}"


def infer_resume_state(session: dict[str, Any], state_log: list[dict[str, Any]]) -> str:
    """Pick which pipeline phase to re-enter after stopped + user instruction."""
    reason = str(session.get("stopped_reason") or "").lower()

    if any(token in reason for token in ("profit target", "trade complete")):
        if session.get("engine_id"):
            return "monitor"
        if session.get("symbol"):
            return "research"
        return "explore"

    if any(token in reason for token in ("explore", "stock picks", "topstockpicks")):
        return "explore"
    if "research" in reason:
        return "research"
    if any(token in reason for token in ("strategy", "setup parameters")):
        return "strategy"
    if "deploy" in reason:
        if any(
            token in reason
            for token in (
                "no strategy configuration",
                "invalid entry price",
                "missing symbol",
                "could not build deploy config",
            )
        ):
            return "strategy"
        return "deploy"
    if "monitor" in reason:
        return "monitor"

    for entry in reversed(state_log):
        if entry.get("to_state") != "stopped":
            continue
        from_state = str(entry.get("from_state") or "").strip()
        if from_state and from_state != "stopped":
            return from_state

    if session.get("symbol") and session.get("token"):
        return "strategy"
    return "explore"
