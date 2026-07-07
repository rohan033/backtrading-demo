"""Prompt fragments and tool classification for autonomous trading sessions."""

from __future__ import annotations

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


def trading_session_prompt_prefix() -> str:
    return f"{TRADING_SESSION_DATA_GUIDANCE}\n\n{TRADING_SESSION_CANDLE_VERIFICATION}"


def trading_session_profit_target_block(session: dict[str, Any]) -> str:
    max_capital = float(session.get("max_capital") or 0)
    profit_target = float(session.get("profit_target") or 0)
    required_pct = (profit_target / max_capital * 100) if max_capital > 0 else 0
    return (
        f"Session goals: max_capital=${max_capital:,.0f}, profit_target=${profit_target:,.0f} "
        f"(requires ~{required_pct:.2f}% move on deployed capital). "
        "Verify this is realistic using get_historical_candles before final output."
    )
