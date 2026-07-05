from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from control_plane.instrument_resolve import resolve_instrument
from control_plane.trading_session_store import SESSION_STATES, TradingSessionStore

PHASE1_STOP_REASON = "Phase 1: explore complete (research not implemented)"
NO_SYMBOL_REASON = "No symbol supplied; agent-driven discovery not implemented yet"
NOT_IMPLEMENTED_REASON = "State not implemented in Phase 1"


@dataclass
class HandlerContext:
    store: TradingSessionStore
    schedule_explore_agent: Callable[[str], None] | None = None


@dataclass
class Transition:
    to_state: str
    reason: str | None = None
    patch: dict[str, Any] | None = None


ExploreAgentRunner = Callable[[str], Awaitable[None]]


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
            to_state="stopped",
            reason=PHASE1_STOP_REASON,
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


async def explore_on_prompt(session: dict[str, Any], prompt: str, ctx: HandlerContext) -> Transition | None:
    return None


async def stub_on_enter(session: dict[str, Any], ctx: HandlerContext) -> Transition | None:
    return Transition(to_state="stopped", reason=NOT_IMPLEMENTED_REASON)


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
        "on_exit": None,
    },
    "research": {"on_enter": stub_on_enter, "on_prompt": None, "on_exit": None},
    "strategy": {"on_enter": stub_on_enter, "on_prompt": None, "on_exit": None},
    "deploy": {"on_enter": stub_on_enter, "on_prompt": None, "on_exit": None},
    "monitor": {"on_enter": stub_on_enter, "on_prompt": None, "on_exit": None},
    "stopped": {"on_enter": stopped_on_enter, "on_prompt": None, "on_exit": None},
}


def is_terminal(state: str) -> bool:
    return state == "stopped"


def validate_state(state: str) -> bool:
    return state in SESSION_STATES
