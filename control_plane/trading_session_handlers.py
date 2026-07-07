from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from control_plane.instrument_resolve import resolve_instrument
from control_plane.trading_session_store import SESSION_STATES, TradingSessionStore

NO_SYMBOL_REASON = "No symbol supplied; agent-driven discovery not implemented yet"


@dataclass
class HandlerContext:
    store: TradingSessionStore
    engine: Any = None
    schedule_explore_agent: Callable[[str], None] | None = None
    schedule_research_agent: Callable[[str], None] | None = None
    schedule_strategy_agent: Callable[[str], None] | None = None
    schedule_monitor_loop: Callable[[str], None] | None = None


@dataclass
class Transition:
    to_state: str
    reason: str | None = None
    patch: dict[str, Any] | None = None


async def explore_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    symbol = str(session.get("symbol") or "").strip()
    token = str(session.get("token") or "").strip()

    if symbol or token:
        resolved = await resolve_instrument(
            session.get("broker") or "etoro",
            session.get("account_env") or "demo",
            symbol=symbol or None,
            token=token or None,
            exchange=session.get("exchange"),
        )
        if not resolved:
            return Transition(
                to_state="stopped",
                reason="Could not resolve instrument for supplied symbol",
            )
        ctx.store.append_event(
            session["id"],
            "symbol_resolved",
            {
                "symbol": resolved.symbol,
                "token": resolved.token,
                "exchange": resolved.exchange,
                "tradingsymbol": resolved.tradingsymbol,
            },
        )
        return Transition(
            to_state="research",
            reason="Symbol resolved — starting research",
            patch={
                "symbol": resolved.symbol,
                "token": resolved.token,
                "exchange": resolved.exchange,
            },
        )

    if ctx.schedule_explore_agent:
        ctx.schedule_explore_agent(session["id"])
        ctx.store.append_event(session["id"], "agent_explore_started", {"state": "explore"})
        return None

    return Transition(to_state="stopped", reason=NO_SYMBOL_REASON)


async def _cancel_session_phase(session: dict[str, Any], phase: str) -> None:
    from control_plane.trading_session_agent_common import cancel_phase_task, cancel_session_agent_run

    await cancel_session_agent_run(session["id"])
    cancel_phase_task(f"{session['id']}:{phase}")


async def research_on_exit(session: dict[str, Any], ctx: HandlerContext) -> None:
    await _cancel_session_phase(session, "research")


async def strategy_on_exit(session: dict[str, Any], ctx: HandlerContext) -> None:
    await _cancel_session_phase(session, "strategy")


async def monitor_on_exit(session: dict[str, Any], ctx: HandlerContext) -> None:
    await _cancel_session_phase(session, "monitor")


async def explore_on_exit(session: dict[str, Any], ctx: HandlerContext) -> None:
    await _cancel_session_phase(session, "explore")


async def explore_on_prompt(session: dict[str, Any], prompt: str, ctx: HandlerContext) -> Transition | None:
    return None


async def research_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    if ctx.schedule_research_agent:
        ctx.schedule_research_agent(session["id"])
        return None
    return Transition(to_state="stopped", reason="Research agent scheduler unavailable")


async def strategy_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    if ctx.schedule_strategy_agent:
        ctx.schedule_strategy_agent(session["id"])
        return None
    return Transition(to_state="stopped", reason="Strategy agent scheduler unavailable")


async def deploy_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    if not ctx.engine:
        return Transition(to_state="stopped", reason="Deploy engine unavailable")
    from control_plane.trading_session_deploy import run_session_deploy

    await run_session_deploy(session["id"], ctx.store, ctx.engine)
    return None


async def monitor_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    if ctx.schedule_monitor_loop:
        ctx.schedule_monitor_loop(session["id"])
        return None
    return Transition(to_state="stopped", reason="Monitor scheduler unavailable")


async def stopped_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    ctx.store.append_event(
        session["id"],
        "session_stopped",
        {"stopped_reason": session.get("stopped_reason")},
    )
    return None


HANDLERS: dict[str, dict[str, Any]] = {
    "explore": {
        "on_enter": explore_on_enter,
        "on_prompt": explore_on_prompt,
        "on_exit": explore_on_exit,
    },
    "research": {"on_enter": research_on_enter, "on_prompt": None, "on_exit": research_on_exit},
    "strategy": {"on_enter": strategy_on_enter, "on_prompt": None, "on_exit": strategy_on_exit},
    "deploy": {"on_enter": deploy_on_enter, "on_prompt": None, "on_exit": None},
    "monitor": {"on_enter": monitor_on_enter, "on_prompt": None, "on_exit": monitor_on_exit},
    "stopped": {"on_enter": stopped_on_enter, "on_prompt": None, "on_exit": None},
}


def is_terminal(state: str) -> bool:
    return state == "stopped"


def validate_state(state: str) -> bool:
    return state in SESSION_STATES
