from __future__ import annotations

import logging
from typing import Any

from api.a2ui_bridge import strategy_summary_surface
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")

from control_plane.agent_autonomous_trade import EXECUTION_SOURCE_AI_RESEARCH


def _latest_strategy_config(store: TradingSessionStore, session_id: str) -> dict[str, Any] | None:
    events = store.list_events(session_id, since_id=0, limit=500)
    for event in reversed(events):
        if event["event_type"] != "strategy_config":
            continue
        config = (event.get("payload") or {}).get("config")
        if isinstance(config, dict) and config.get("symbol") and config.get("token"):
            return config
    return None


async def resolve_deploy_config(
    session_id: str,
    store: TradingSessionStore,
    session: dict[str, Any],
) -> dict[str, Any] | None:
    config = _latest_strategy_config(store, session_id)
    if config:
        return config

    from control_plane.trading_session_strategy import prepare_session_strategy_config

    log.info("[TRADING_SESSION] no strategy_config event — building inline session=%s", session_id)
    return await prepare_session_strategy_config(session_id, store)


async def run_session_deploy(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    session = store.get_session(session_id)
    if not session or session.get("state") != "deploy":
        return

    config = await resolve_deploy_config(session_id, store, session)
    if not config:
        await engine.stop_session(session_id, "Deploy failed: no strategy configuration")
        return

    broker = str(config.get("broker") or session.get("broker") or "etoro").lower()
    if broker != "etoro":
        await engine.stop_session(session_id, f"Deploy unsupported broker: {broker}")
        return

    account_env = str(config.get("account_env") or session.get("account_env") or "demo").lower()

    try:
        entry_price = float(config.get("close_price") or 0)
    except (TypeError, ValueError):
        entry_price = 0.0
    if entry_price <= 0:
        from control_plane.trading_session_strategy import prepare_session_strategy_config

        refreshed = await prepare_session_strategy_config(session_id, store)
        if refreshed:
            config = refreshed
            try:
                entry_price = float(config.get("close_price") or 0)
            except (TypeError, ValueError):
                entry_price = 0.0
    if entry_price <= 0:
        await engine.stop_session(session_id, "Deploy failed: invalid entry price")
        return

    symbol = str(config.get("symbol") or session.get("symbol") or "").strip()
    token = str(config.get("token") or session.get("token") or "").strip()
    if not symbol or not token:
        await engine.stop_session(session_id, "Deploy failed: missing symbol/token")
        return

    store.append_event(session_id, "deploy_started", {"symbol": symbol, "broker": broker})

    placing = strategy_summary_surface(
        symbol=symbol.split("-")[0],
        execution_id="",
        entry_price=entry_price,
        status="placing order",
        broker=broker,
        account_env=account_env,
        long_percent=float(config.get("long_percent") or 2),
        short_percent=float(config.get("short_percent") or 1),
        capital=float(config.get("max_available_capital") or session.get("max_capital") or 0),
    )
    store.append_event(session_id, "agent_a2ui_surface", placing)

    from api.server import MomentumEnterRequest, momentum_enter
    from fastapi import HTTPException

    try:
        response = await momentum_enter(
            MomentumEnterRequest(
                broker="etoro",
                account_env=account_env,
                symbol=symbol,
                token=token,
                exchange=str(config.get("exchange") or session.get("exchange") or "ETORO"),
                close_price=entry_price,
                long_percent=float(config.get("long_percent") or 2),
                short_percent=float(config.get("short_percent") or 1),
                max_available_capital=float(
                    config.get("max_available_capital") or session.get("max_capital") or 5000
                ),
                allow_partial_stocks=True,
                source_id=EXECUTION_SOURCE_AI_RESEARCH,
                source_meta_id=session_id,
            )
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        store.append_event(session_id, "deploy_failed", {"error": detail})
        await engine.stop_session(session_id, f"Deploy failed: {detail}")
        return
    except Exception as exc:
        log.exception("[TRADING_SESSION] deploy failed session=%s", session_id)
        store.append_event(session_id, "deploy_failed", {"error": str(exc)})
        await engine.stop_session(session_id, f"Deploy error: {exc}")
        return

    data = (response or {}).get("data") or {}
    execution_id = str(data.get("execution_id") or "").strip()
    if not execution_id:
        await engine.stop_session(session_id, "Deploy failed: no execution_id returned")
        return

    capital_used = float(
        config.get("max_available_capital") or session.get("max_capital") or 0
    )

    summary = strategy_summary_surface(
        symbol=symbol,
        execution_id=execution_id,
        entry_price=entry_price,
        status="running",
        broker=broker,
        account_env=account_env,
        long_percent=float(config.get("long_percent") or 2),
        short_percent=float(config.get("short_percent") or 1),
        capital=capital_used,
    )
    store.append_event(session_id, "agent_a2ui_surface", summary)
    store.append_event(
        session_id,
        "deploy_complete",
        {
            "execution_id": execution_id,
            "symbol": symbol,
            "entry_price": entry_price,
            "capital_used": capital_used,
        },
    )

    await engine.transition_session(
        session_id,
        to_state="monitor",
        reason="Trade deployed",
        patch={"engine_id": execution_id},
    )
