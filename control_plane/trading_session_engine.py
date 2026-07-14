from __future__ import annotations

import logging
from typing import Any

from control_plane.trading_session_agent_common import cancel_all_session_tasks, cancel_session_agent_run
from control_plane.trading_session_explore import cancel_explore_agent, schedule_explore_agent
from control_plane.trading_session_handlers import (
    HANDLERS,
    HandlerContext,
    Transition,
    is_terminal,
)
from control_plane.trading_session_monitor import schedule_monitor_loop
from control_plane.trading_session_research import schedule_research_agent
from control_plane.trading_session_strategy import schedule_strategy_agent
from control_plane.trading_session_store import TradingSessionStore

log = logging.getLogger("backtrading")


class TradingSessionEngine:
    """Orchestrator: reload session from DB on every dispatch; persist after each step."""

    def __init__(self, store: TradingSessionStore | None = None):
        self.store = store or TradingSessionStore()

    def _handler_ctx(self) -> HandlerContext:
        return HandlerContext(
            store=self.store,
            engine=self,
            schedule_explore_agent=lambda sid: schedule_explore_agent(sid, self.store, self),
            schedule_research_agent=lambda sid: schedule_research_agent(sid, self.store, self),
            schedule_strategy_agent=lambda sid: schedule_strategy_agent(sid, self.store, self),
            schedule_monitor_loop=lambda sid: schedule_monitor_loop(sid, self.store, self),
        )

    async def create_session(self, req: dict[str, Any]) -> dict[str, Any]:
        session = self.store.create_session(
            broker=req.get("broker") or "etoro",
            account_env=req.get("account_env") or "demo",
            max_capital=float(req.get("max_capital") or 0),
            profit_target=float(req.get("profit_target") or 0),
            symbol=req.get("symbol"),
            token=req.get("token"),
            exchange=req.get("exchange"),
        )
        self.store.append_event(
            session["id"],
            "session_created",
            {
                "account_env": session["account_env"],
                "broker": session["broker"],
                "max_capital": session["max_capital"],
                "profit_target": session["profit_target"],
                "symbol": session.get("symbol"),
            },
        )
        await self._enter_state(session["id"], "explore", from_state=None, reason="session created")
        return self.get_session_detail(session["id"])  # type: ignore[return-value]

    def get_session_detail(self, session_id: str) -> dict[str, Any] | None:
        session = self.store.get_session(session_id)
        if not session:
            return None
        return {
            **session,
            "state_log": self.store.list_state_log(session_id),
        }

    async def dispatch_prompt(self, session_id: str, prompt: str) -> dict[str, Any] | None:
        session = self.store.get_session(session_id)
        if not session:
            return None

        user_prompt = str(prompt or "").strip()
        if not user_prompt:
            return self.get_session_detail(session_id)

        state = session["state"]
        if is_terminal(state):
            handler = HANDLERS.get(state, {})
            on_prompt = handler.get("on_prompt")
            if not on_prompt:
                return self.get_session_detail(session_id)
            transition = await on_prompt(session, user_prompt, self._handler_ctx())
            if transition:
                await self._apply_transition(session_id, transition)
            return self.get_session_detail(session_id)

        handler = HANDLERS.get(state, {})
        on_prompt = handler.get("on_prompt")
        transition = None
        if on_prompt:
            transition = await on_prompt(session, user_prompt, self._handler_ctx())

        self.store.append_event(
            session_id,
            "prompt_handled",
            {"state": state, "prompt": user_prompt[:500]},
        )

        if transition:
            await self._apply_transition(session_id, transition)
        return self.get_session_detail(session_id)

    async def stop_session(
        self,
        session_id: str,
        reason: str = "Stopped by user",
        *,
        skip_task_cancel: bool = False,
    ) -> dict[str, Any] | None:
        await cancel_session_agent_run(session_id)
        cancel_explore_agent(session_id, skip_current=skip_task_cancel)
        cancel_all_session_tasks(session_id, skip_current=skip_task_cancel)
        session = self.store.get_session(session_id)
        if not session:
            return None
        if is_terminal(session["state"]):
            return self.get_session_detail(session_id)

        await self._exit_state(session_id, session["state"])
        await self._enter_state(
            session_id,
            "stopped",
            from_state=session["state"],
            reason=reason,
            patch={"stopped_reason": reason},
        )
        return self.get_session_detail(session_id)

    async def delete_session(self, session_id: str) -> bool:
        await cancel_session_agent_run(session_id)
        cancel_explore_agent(session_id)
        cancel_all_session_tasks(session_id)
        session = self.store.get_session(session_id)
        if not session:
            return False
        return self.store.delete_session(session_id)

    async def transition_session(
        self,
        session_id: str,
        *,
        to_state: str,
        reason: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        await self._apply_transition(session_id, Transition(to_state=to_state, reason=reason, patch=patch))
        return self.get_session_detail(session_id)

    async def _apply_transition(self, session_id: str, transition: Transition) -> None:
        session = self.store.get_session(session_id)
        if not session:
            return
        from_state = session["state"]
        if from_state != transition.to_state:
            await self._exit_state(session_id, from_state)
        await self._enter_state(
            session_id,
            transition.to_state,
            from_state=from_state,
            reason=transition.reason,
            patch=transition.patch,
        )

    async def _exit_state(self, session_id: str, state: str) -> None:
        handler = HANDLERS.get(state, {})
        on_exit = handler.get("on_exit")
        if on_exit:
            session = self.store.get_session(session_id)
            if session:
                await on_exit(session, self._handler_ctx())

    async def _enter_state(
        self,
        session_id: str,
        state: str,
        *,
        from_state: str | None,
        reason: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> None:
        session = self.store.get_session(session_id)
        if not session:
            return

        update_patch: dict[str, Any] = {"state": state}
        if patch:
            update_patch.update(patch)
        if state == "stopped" and reason and "stopped_reason" not in update_patch:
            update_patch["stopped_reason"] = reason

        self.store.update_session(session_id, update_patch)
        self.store.append_state_transition(
            session_id,
            from_state=from_state,
            to_state=state,
            reason=reason,
        )
        self.store.append_event(
            session_id,
            "state_entered",
            {"state": state, "from_state": from_state, "reason": reason},
        )

        handler = HANDLERS.get(state, {})
        on_enter = handler.get("on_enter")
        if not on_enter:
            return

        session = self.store.get_session(session_id)
        if not session:
            return
        transition = await on_enter(session, self._handler_ctx())
        if transition:
            await self._apply_transition(session_id, transition)
