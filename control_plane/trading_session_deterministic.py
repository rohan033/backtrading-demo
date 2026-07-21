"""Deterministic server-side fallbacks when agent output is missing or unreliable."""

from __future__ import annotations

import logging
from typing import Any

from control_plane.instrument_resolve import pick_best_match, search_instruments

log = logging.getLogger("backtrading")

DEFAULT_ETORO_TICKERS = ("NVDA", "META", "AMD", "TSLA", "AAPL")

# Last-resort when MCP search is unavailable (demo / offline).
STATIC_ETORO_PICKS: tuple[dict[str, str], ...] = (
    {"symbol": "NVDA", "name": "NVIDIA", "token": "1111", "exchange": "ETORO"},
    {"symbol": "TSLA", "name": "Tesla", "token": "1137", "exchange": "ETORO"},
    {"symbol": "AMD", "name": "AMD", "token": "1122", "exchange": "ETORO"},
)


async def deterministic_explore_picks(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Server-side stock shortlist — no agent required."""
    from control_plane.instrument_resolve import find_watchlist_instrument

    broker = str(session.get("broker") or "etoro").lower()
    account_env = str(session.get("account_env") or "demo").lower()
    exchange = "ETORO" if broker == "etoro" else str(session.get("exchange") or "NSE")

    picks: list[dict[str, Any]] = []
    for ticker in DEFAULT_ETORO_TICKERS:
        if len(picks) >= 3:
            break
        watchlist_hit = find_watchlist_instrument(broker, account_env, ticker)
        if watchlist_hit:
            symbol = str(watchlist_hit.get("tradingsymbol") or ticker).strip()
            token = str(watchlist_hit.get("symboltoken") or "").strip()
            if symbol and token:
                picks.append({
                    "symbol": symbol,
                    "name": str(watchlist_hit.get("name") or symbol.split("-")[0]),
                    "token": token,
                    "exchange": str(watchlist_hit.get("exchange") or exchange),
                    "recommendation": (
                        f"Watchlist pick — {symbol.split('-')[0]} from "
                        f"{watchlist_hit.get('watchlist_name') or 'watchlist'}"
                    ),
                    "from_watchlist": True,
                })
                continue
        try:
            rows = await search_instruments(
                broker,
                account_env,
                ticker,
                exchange=exchange,
            )
        except Exception:
            log.exception("[TRADING_SESSION] deterministic search failed ticker=%s", ticker)
            continue
        row = pick_best_match(rows, ticker)
        if not row:
            continue
        symbol = str(row.get("tradingsymbol") or row.get("symbol") or ticker).strip()
        token = str(row.get("symboltoken") or row.get("token") or "").strip()
        if not symbol or not token:
            continue
        picks.append({
            "symbol": symbol,
            "name": str(row.get("name") or symbol.split("-")[0]),
            "token": token,
            "exchange": str(row.get("exchange") or exchange),
            "recommendation": f"Deterministic pick — {symbol.split('-')[0]} via {broker} search",
            "from_watchlist": bool(row.get("from_watchlist")),
        })

    if picks:
        return picks

    if broker == "etoro":
        return [
            {
                **row,
                "recommendation": f"Static fallback — {row['symbol']} (server default)",
            }
            for row in STATIC_ETORO_PICKS[:3]
        ]

    return picks


async def build_deterministic_strategy_config(
    session: dict[str, Any],
    *,
    entry_price: float | None = None,
) -> dict[str, Any] | None:
    """Always produce deploy params from session symbol + live LTP."""
    from control_plane.trading_session_agent_common import synthesize_strategy_from_session_ltp

    symbol = str(session.get("symbol") or "").strip()
    token = str(session.get("token") or "").strip()
    if not symbol or not token:
        return None

    config = await synthesize_strategy_from_session_ltp(session, entry_price=entry_price)
    if config:
        return config

    broker = str(session.get("broker") or "etoro").lower()
    max_capital = float(session.get("max_capital") or 5000)
    profit_target = float(session.get("profit_target") or 0)
    long_pct = round((profit_target / max_capital * 100), 2) if max_capital > 0 and profit_target > 0 else 2.0
    short_pct = max(1.0, round(long_pct / 2, 2))

    if broker == "etoro":
        log.warning("[TRADING_SESSION] LTP unavailable — using static entry for %s", symbol)
        return {
            "symbol": symbol,
            "token": token,
            "exchange": session.get("exchange") or "ETORO",
            "broker": broker,
            "account_env": str(session.get("account_env") or "demo").lower(),
            "close_price": float(entry_price or 100.0),
            "long_percent": long_pct,
            "short_percent": short_pct,
            "initial_threshold": 0.2,
            "max_available_capital": max_capital,
            "synthesized": True,
            "hard_fallback": True,
        }

    return None
