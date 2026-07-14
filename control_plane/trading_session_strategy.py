from __future__ import annotations

import logging
from typing import Any

from api.a2ui_bridge import component_to_surface

from control_plane.instrument_resolve import resolve_instrument
from control_plane.trading_session_deterministic import build_deterministic_strategy_config
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")


async def _ensure_session_symbol_token(
    session_id: str,
    store: TradingSessionStore,
    session: dict[str, Any],
) -> dict[str, Any]:
    symbol = str(session.get("symbol") or "").strip()
    token = str(session.get("token") or "").strip()
    if symbol and token:
        return session

    if not symbol and not token:
        return session

    resolved = await resolve_instrument(
        session.get("broker") or "etoro",
        session.get("account_env") or "demo",
        symbol=symbol or None,
        token=token or None,
        exchange=session.get("exchange"),
    )
    if not resolved:
        return session

    patch = {
        "symbol": resolved.symbol,
        "token": resolved.token,
        "exchange": resolved.exchange,
    }
    store.update_session(session_id, patch)
    return store.get_session(session_id) or {**session, **patch}


async def prepare_session_strategy_config(
    session_id: str,
    store: TradingSessionStore,
) -> dict[str, Any] | None:
    """Build, persist, and return deploy config — always callable before deploy."""
    session = store.get_session(session_id)
    if not session:
        return None

    session = await _ensure_session_symbol_token(session_id, store, session)
    if not session.get("symbol") or not session.get("token"):
        log.warning("[TRADING_SESSION] strategy config missing symbol/token session=%s", session_id)
        return None

    config = await build_deterministic_strategy_config(session)
    if not config:
        log.warning("[TRADING_SESSION] could not build strategy config session=%s", session_id)
        return None

    config.setdefault("symbol", session.get("symbol"))
    config.setdefault("token", session.get("token"))
    config.setdefault("exchange", session.get("exchange"))
    config.setdefault("broker", session.get("broker"))
    config.setdefault("account_env", session.get("account_env"))
    config.setdefault("max_available_capital", session.get("max_capital"))

    store.append_event(session_id, "agent_strategy_started", {"state": "strategy", "deterministic": True})
    store.append_event(session_id, "strategy_config", {"config": config, "source": "deterministic"})
    store.append_event(
        session_id,
        "agent_a2ui_surface",
        component_to_surface(
            "StrategySummary",
            {
                "symbol": str(config.get("symbol") or "").split("-")[0],
                "entry_price": config.get("close_price"),
                "long_percent": config.get("long_percent"),
                "short_percent": config.get("short_percent"),
                "capital": config.get("max_available_capital"),
                "broker": config.get("broker"),
                "account_env": config.get("account_env"),
                "status": "auto-deploying",
            },
        ),
    )
    return config


async def run_deterministic_strategy(
    session_id: str,
    store: TradingSessionStore,
    engine: Any,
) -> None:
    """Legacy entry point — prefer synchronous strategy_on_enter."""
    session = store.get_session(session_id)
    if not session or session.get("state") != "strategy":
        return

    try:
        config = await prepare_session_strategy_config(session_id, store)
        if not config:
            await engine.stop_session(session_id, "Strategy failed: could not build deploy config", skip_task_cancel=True)
            return

        await engine.transition_session(
            session_id,
            to_state="deploy",
            reason="Deterministic strategy ready",
            patch={"strategy_type": "momentum"},
        )
    except Exception as exc:
        log.exception("[TRADING_SESSION] deterministic strategy failed session=%s", session_id)
        store.append_event(session_id, "agent_strategy_failed", {"reason": str(exc)})
        await engine.stop_session(session_id, f"Strategy error: {exc}", skip_task_cancel=True)


run_agent_strategy = run_deterministic_strategy


def schedule_strategy_agent(session_id: str, store: TradingSessionStore, engine: Any) -> None:
    from control_plane.trading_session_agent_common import schedule_phase_task

    schedule_phase_task(
        f"{session_id}:strategy",
        lambda: run_deterministic_strategy(session_id, store, engine),
    )
