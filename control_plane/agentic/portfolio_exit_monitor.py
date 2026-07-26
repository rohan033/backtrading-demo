"""Execute portfolio-monitor profit plans (uptrend-break secure, rebuy signals)."""

from __future__ import annotations

import time
from typing import Any

from control_plane.agentic.events import EventTier, EventType
from control_plane.agentic.live_feed import get_ws_price, refresh_agentic_feed_subscriptions
from control_plane.agentic.profit_planner import (
    compute_exit_plan,
    profit_window_seconds,
    scan_rebuy_watchlist,
)
from control_plane.agentic.profit_price_tracker import get_profit_price_tracker


def _resolve_live_price(
    session: dict[str, Any],
    ticker: str,
    *,
    position: dict[str, Any],
) -> tuple[float, str]:
    """Prefer websocket LTP; fall back to last known position price."""
    session_id = str(session["id"])
    account_env = str(session.get("account_env") or "demo")
    ws_price = get_ws_price(session_id, ticker, account_env)
    if ws_price is not None and ws_price > 0:
        return ws_price, "websocket"
    fallback = float(
        position.get("current_price") or position.get("buy_price") or 0.0
    )
    return fallback, "snapshot"


async def manage_portfolio_exits(
    session: dict[str, Any],
    store: Any,
    snapshot: Any,
    *,
    publish: Any,
) -> dict[str, Any]:
    """Every ~30s: evaluate uptrend on websocket samples; secure when trend breaks."""
    from control_plane.agentic.session_engine import close_position_now

    config = session.get("config") or {}
    window_seconds = profit_window_seconds(config)
    session_id = str(session["id"])
    tracker = get_profit_price_tracker()

    await refresh_agentic_feed_subscriptions()

    prior_plans = (store.get_session(session_id) or {}).get("snapshot") or {}
    prior_plans = prior_plans.get("exit_plans") if isinstance(prior_plans, dict) else {}
    if not isinstance(prior_plans, dict):
        prior_plans = {}
    next_plans: dict[str, Any] = dict(prior_plans)
    profit_actions = 0
    rebuy_candidates: list[dict[str, Any]] = []

    open_positions = store.list_positions(session_id, states=("open",))
    held = {str(row["ticker"]).upper() for row in open_positions}
    watchlist = {
        str(ticker).upper()
        for ticker in (config.get("tickers") or [])
        if ticker
    }
    open_slots = sorted(ticker for ticker in watchlist if ticker not in held)

    if open_positions:
        for position in open_positions:
            position_id = position["id"]
            ticker = str(position["ticker"]).upper()
            price, price_source = _resolve_live_price(session, ticker, position=position)
            if price > 0:
                tracker.record(session_id, ticker, price, source=price_source)
                store.update_position(
                    position_id,
                    {
                        "current_price": price,
                        "unrealized_pnl": (price - float(position["buy_price"] or 0.0))
                        * float(position["units"] or 0.0),
                    },
                )
                position = store.get_position(position_id) or position

            window_stats = tracker.window_stats(
                session_id,
                ticker,
                window_seconds=window_seconds,
                current_price=price if price > 0 else None,
            )
            plan = compute_exit_plan(
                position,
                window_stats=window_stats,
                config=config,
                prior=prior_plans.get(position_id),
            )
            plan["price_source"] = price_source
            next_plans[position_id] = plan

            if not plan.get("active"):
                continue

            if not plan.get("should_secure"):
                continue

            profit_lock = float(plan.get("profit_lock") or 0.0)
            refreshed = store.get_position(position_id) or position
            if refreshed.get("state") != "open":
                continue

            await close_position_now(
                session,
                refreshed,
                reason="uptrend break — profit secure",
                exit_price=price,
            )
            profit_actions += 1
            plan["active"] = False
            plan["should_secure"] = False
            next_plans[position_id] = plan
            await publish(
                EventType.PROFIT_SECURED,
                EventTier.FAST,
                {
                    "position_id": position_id,
                    "price": price,
                    "profit_lock": profit_lock,
                    "peak_price": plan.get("peak_price"),
                    "uptrend_intact": plan.get("uptrend_intact"),
                    "reason": (
                        f"{ticker} uptrend broke — secured @ {price:.4f} "
                        f"(peak {float(plan.get('peak_price') or price):.4f}, lock {profit_lock:.4f})"
                    ),
                },
                ticker=ticker,
                dedupe_key=f"profit-secure:{position_id}",
            )

    if open_slots and session.get("status") == "running" and not session.get("stop_reason"):
        for ticker in open_slots[:4]:
            price, price_source = _resolve_live_price(
                session,
                ticker,
                position={"current_price": 0, "buy_price": 0},
            )
            if price > 0:
                tracker.record(session_id, ticker, price, source=price_source)
            window_stats = tracker.window_stats(
                session_id,
                ticker,
                window_seconds=window_seconds,
                current_price=price if price > 0 else None,
            )
            signal = scan_rebuy_watchlist(ticker, window_stats=window_stats, config=config)
            if not signal:
                continue
            rebuy_candidates.append(signal)
            await publish(
                EventType.REBUY_CANDIDATE,
                EventTier.FAST,
                {
                    **signal,
                    "reason": (
                        f"{ticker} rising +{signal['move_pct']:.2f}% over "
                        f"{int(signal.get('window_seconds') or window_seconds)}s — review rebuy"
                    ),
                },
                ticker=ticker,
                dedupe_key=f"rebuy:{ticker}:{int(time.time() // 300)}",
            )

    def persist_plans(state: dict[str, Any]) -> None:
        state["exit_plans"] = next_plans

    snapshot.mutate(persist_plans)

    return {
        "profit_actions": profit_actions,
        "rebuy_candidates": rebuy_candidates,
        "exit_plans": next_plans,
    }
