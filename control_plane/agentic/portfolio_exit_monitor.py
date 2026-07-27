"""Execute portfolio-monitor profit plans (secure exit, pullback ladder, stall trim)."""

from __future__ import annotations

import time
from typing import Any

from control_plane.agentic.events import EventTier, EventType
from control_plane.agentic.live_feed import get_ws_price, refresh_agentic_feed_subscriptions
from control_plane.agentic.profit_planner import (
    compute_exit_plan,
    evaluate_ladder,
    evaluate_stall,
    profit_window_seconds,
    scan_rebuy_watchlist,
)
from control_plane.agentic.profit_price_tracker import get_profit_price_tracker

_MIN_TRIM_FRACTION = 0.01


async def _apply_partial_close(
    session: dict[str, Any],
    store: Any,
    position: dict[str, Any],
    plan: dict[str, Any],
    *,
    fraction_of_original: float,
    price: float,
    reason: str,
) -> dict[str, Any] | None:
    """Shared trim ledger: all ladder/stall trims are sized as fractions of the
    ORIGINAL entry, budgeted against plan['remaining_fraction'] so combined
    trims can never oversell. close_position_now() takes a fraction of the
    units *currently* held, so we convert before calling it."""
    from control_plane.agentic.session_engine import close_position_now

    remaining = float(plan.get("remaining_fraction", 1.0))
    requested = min(float(fraction_of_original), remaining)
    if requested < _MIN_TRIM_FRACTION or remaining < _MIN_TRIM_FRACTION:
        return None

    fraction_of_current = min(1.0, requested / remaining)
    refreshed = store.get_position(position["id"]) or position
    if refreshed.get("state") != "open":
        return None
    updated = await close_position_now(
        session,
        refreshed,
        fraction=fraction_of_current,
        reason=reason,
        exit_price=price,
    )
    plan["remaining_fraction"] = round(max(0.0, remaining - requested), 6)
    return updated


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
                broker_synced = bool((position.get("meta") or {}).get("broker_synced"))
                if not broker_synced:
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

            # Sync the trim ledger with actual held units so trims made
            # elsewhere (weakening trim, manual closes) shrink the budget too.
            units_now = float(position.get("units") or 0.0)
            entry_units = float(plan.get("entry_units") or 0.0)
            if entry_units <= 0 and units_now > 0:
                entry_units = units_now
                plan["entry_units"] = units_now
            if entry_units > 0:
                plan["remaining_fraction"] = round(
                    min(1.0, max(0.0, units_now / entry_units)), 6
                )
            next_plans[position_id] = plan

            if not plan.get("active"):
                continue

            # Layer 1 — full secure exit on uptrend break. If it fires, the
            # ladder and stall checks are moot for this position.
            if plan.get("should_secure"):
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
                plan["remaining_fraction"] = 0.0
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
                continue

            buy_price = float(position.get("buy_price") or 0.0)

            # Layer 2 — pullback ladder. Rungs fire when price falls TO a
            # target (fractions of peak gain), highest rung first. Each hit
            # trims a slice of original size and ratchets the hard stop:
            # first hit -> breakeven+buffer, later hits -> prior rung's
            # hit price (protection tightens as the give-back deepens).
            for level in evaluate_ladder(plan, buy_price=buy_price, price=price):
                updated = await _apply_partial_close(
                    session,
                    store,
                    position,
                    plan,
                    fraction_of_original=float(level.get("fraction") or 0.0),
                    price=price,
                    reason=f"profit ladder {level.get('id')} pullback",
                )
                if updated is None:
                    continue
                position = updated
                profit_actions += 1

                prior_hit = plan.get("last_hit_price")
                if prior_hit is None:
                    new_floor = buy_price * 1.001
                else:
                    new_floor = float(prior_hit)
                current_stop = float(position.get("stop_loss") or 0.0)
                if new_floor > current_stop:
                    store.update_position(position_id, {"stop_loss": round(new_floor, 6)})
                    position = store.get_position(position_id) or position
                plan["last_hit_price"] = float(level.get("hit_price") or price)

                await publish(
                    EventType.PROFIT_LEVEL_HIT,
                    EventTier.FAST,
                    {
                        "position_id": position_id,
                        "level": level.get("id"),
                        "price": price,
                        "target": level.get("price"),
                        "peak_price": plan.get("peak_price"),
                        "remaining_fraction": plan.get("remaining_fraction"),
                        "reason": (
                            f"{ticker} pulled back to ladder {level.get('id')} "
                            f"({level.get('label')}) — trimmed @ {price:.4f}"
                        ),
                    },
                    ticker=ticker,
                    dedupe_key=f"profit-ladder:{position_id}:{level.get('id')}",
                )
                if position.get("state") != "open":
                    break
            next_plans[position_id] = plan
            if position.get("state") != "open":
                continue

            # Layer 3 — stall detector (partial trim unless partial_profits mode).
            if not config.get("partial_profits_enabled") and evaluate_stall(plan, config=config):
                stall_fraction = float(config.get("profit_stall_trim_fraction", 0.15))
                updated = await _apply_partial_close(
                    session,
                    store,
                    position,
                    plan,
                    fraction_of_original=stall_fraction,
                    price=price,
                    reason="peak stalled — partial secure",
                )
                if updated is not None:
                    position = updated
                    profit_actions += 1
                    await publish(
                        EventType.PROFIT_STALL_TRIM,
                        EventTier.FAST,
                        {
                            "position_id": position_id,
                            "price": price,
                            "peak_price": plan.get("peak_price"),
                            "remaining_fraction": plan.get("remaining_fraction"),
                            "reason": (
                                f"{ticker} stalled near peak "
                                f"{float(plan.get('peak_price') or price):.4f} — "
                                f"trimmed {int(stall_fraction * 100)}% @ {price:.4f}"
                            ),
                        },
                        ticker=ticker,
                        dedupe_key=f"profit-stall:{position_id}:{int(time.time() // 60)}",
                    )
                next_plans[position_id] = plan

    # Partial-profits mode: force-close every open position that is in profit
    # and has stalled near peak (no new high for profit_peak_stale_seconds).
    if config.get("partial_profits_enabled"):
        still_open = store.list_positions(session_id, states=("open",))
        stall_closes: list[tuple[dict[str, Any], dict[str, Any], float, str]] = []
        for position in still_open:
            position_id = position["id"]
            ticker = str(position["ticker"]).upper()
            plan = next_plans.get(position_id)
            if not plan or not plan.get("active"):
                continue
            buy_price = float(position.get("buy_price") or 0.0)
            price, _ = _resolve_live_price(session, ticker, position=position)
            if price <= buy_price:
                continue
            if not evaluate_stall(plan, config=config):
                continue
            stall_closes.append((position, plan, price, ticker))

        for position, plan, price, ticker in stall_closes:
            position_id = position["id"]
            refreshed = store.get_position(position_id) or position
            if refreshed.get("state") != "open":
                continue
            await close_position_now(
                session,
                refreshed,
                reason="stagnant profit — partial profits force close",
                exit_price=price,
            )
            profit_actions += 1
            plan["active"] = False
            plan["remaining_fraction"] = 0.0
            plan["stall_handled"] = True
            next_plans[position_id] = plan
            await publish(
                EventType.PROFIT_STALL_TRIM,
                EventTier.FAST,
                {
                    "position_id": position_id,
                    "price": price,
                    "peak_price": plan.get("peak_price"),
                    "force_close": True,
                    "partial_profits_enabled": True,
                    "reason": (
                        f"{ticker} profit stagnant near peak "
                        f"{float(plan.get('peak_price') or price):.4f} — "
                        f"force closed @ {price:.4f}"
                    ),
                },
                ticker=ticker,
                dedupe_key=f"profit-stall-close:{position_id}:{int(time.time() // 60)}",
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
