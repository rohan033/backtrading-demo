"""Meaningful-event orchestrator and deterministic critical-event router."""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.agent_contract import (
    clamp_confidence,
    emit_agent_response,
    one_line,
    plain_text,
)
from control_plane.agentic.analysts import AnalystDispatcher
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.events import AgentEvent, EventTier, EventType
from control_plane.agentic.snapshot import SessionSnapshot


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


ACTION_LABELS = {
    "CONSIDER_ENTRY": "Considering entry",
    "HOLD": "Holding — no action",
    "PROTECT_POSITION": "Protecting position",
    "REVIEW_EXIT": "Reviewing exit",
}

SUBAGENT_LABELS = {
    "momentum_analyst": "Momentum Analyst",
    "news_analyst": "News Analyst",
    "portfolio_impact_analyst": "Portfolio Impact Analyst",
    "exit_planner": "Exit Planner",
}


def _recent(iso_value: Any, seconds: float = 30.0) -> bool:
    try:
        value = datetime.fromisoformat(str(iso_value))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - value).total_seconds() <= seconds
    except (TypeError, ValueError):
        return False


class CriticalEventRouter:
    """Executes immutable risk controls before any model can see the event."""

    def __init__(self, store: Any) -> None:
        self.store = store

    async def route(self, event: AgentEvent) -> bool:
        if event.tier != EventTier.CRITICAL:
            return False
        session = self.store.get_session(event.session_id)
        if not session:
            return True
        reason = str(event.payload.get("reason") or event.type.value.replace("_", " "))
        self.store.update_session(event.session_id, {"stop_reason": reason})
        self.store.add_event(
            event.session_id,
            "risk_action",
            f"Deterministic circuit breaker: {reason}",
            ticker=event.ticker,
            meta={"provenance": event.source, "tier": "critical", "llm_bypassed": True},
        )
        from control_plane.agentic.session_engine import close_position_now

        if event.type == EventType.STOP_LOSS and event.payload.get("position_id"):
            position = self.store.get_position(str(event.payload["position_id"]))
            targets = [position] if position and position.get("state") == "open" else []
        else:
            self.store.update_session(event.session_id, {"stop_reason": reason})
            targets = self.store.list_positions(event.session_id, states=("open",))
        for position in targets:
            await close_position_now(
                session,
                position,
                reason=f"deterministic {event.type.value}",
                exit_price=event.payload.get("price"),
            )
        return True


class TradingOrchestrator:
    def __init__(self, session_id: str, store: Any, bus: Any) -> None:
        self.session_id = session_id
        self.store = store
        self.bus = bus
        self.snapshot = SessionSnapshot(store, session_id)
        self.dispatcher = AnalystDispatcher()
        self.critical = CriticalEventRouter(store)
        self._wakeups: deque[float] = deque()
        self._last_by_type: dict[str, float] = {}

    async def run(self) -> None:
        while True:
            event = await self.bus.next()
            if await self.critical.route(event):
                self._service_state("idle", "Critical event handled without LLM")
                continue
            if event.tier == EventTier.OBSERVATION:
                continue
            session = self.store.get_session(self.session_id)
            if not session or session.get("status") != "running":
                continue
            if self.snapshot.subagents_halted():
                self._service_state("idle", "Subagents halted — skipping LLM wakeup")
                continue
            config = session.get("config") or {}
            if not self._within_budget(config, event):
                self.store.add_event(
                    self.session_id,
                    "orchestrator",
                    f"Wakeup suppressed: {event.type.value} (cooldown/budget)",
                    ticker=event.ticker,
                    meta={"tier": event.tier.value, "provenance": "main_orchestrator"},
                )
                continue
            self._service_state("running", f"Evaluating {event.type.value.replace('_', ' ')}")
            snapshot = self.snapshot.hydrate()
            timeout = float(
                config.get(
                    "fast_reasoning_timeout_seconds"
                    if event.tier == EventTier.FAST
                    else "strategic_reasoning_timeout_seconds",
                    DEFAULT_CONFIG[
                        "fast_reasoning_timeout_seconds"
                        if event.tier == EventTier.FAST
                        else "strategic_reasoning_timeout_seconds"
                    ],
                )
            )
            # Spawn the short-lived sub-agents this event calls for; each surfaces
            # in Agents Status and returns {data, oneline, confidence}.
            analyst_results = await self._spawn_subagents(event, snapshot, timeout)
            fallback_action = self._recommend(event, analyst_results)
            llm_decision = await self._ask_llm(
                session, event, analyst_results, timeout
            )
            self._emit_orchestrator_response(
                event, analyst_results, llm_decision, fallback_action
            )
            self._service_state("idle", "Waiting for meaningful event")

    async def evaluate_candidate(self, suggestion: dict[str, Any]) -> bool:
        """Synchronous entry gate used by the execution engine."""
        session = self.store.get_session(self.session_id)
        if not session or session.get("status") != "running":
            return False
        if self.snapshot.subagents_halted():
            return False
        event = AgentEvent(
            session_id=self.session_id,
            type=EventType.CANDIDATE_FOUND,
            tier=EventTier.FAST,
            source="market_hunter",
            ticker=str(suggestion.get("ticker") or ""),
            payload=dict(suggestion),
            dedupe_key=f"candidate:{suggestion.get('ticker')}",
        )
        config = session.get("config") or {}
        if not self._within_budget(config, event):
            snapshot = self.snapshot.hydrate()
            recent = next(
                (
                    item
                    for item in reversed(snapshot.get("recommendations") or [])
                    if item.get("ticker") == event.ticker
                    and item.get("event_type") == EventType.CANDIDATE_FOUND.value
                    and _recent(item.get("created_at"))
                ),
                None,
            )
            if recent and recent.get("action") == "CONSIDER_ENTRY":
                emit_agent_response(
                    self.store,
                    self.session_id,
                    agent="main_orchestrator",
                    data=plain_text(
                        recent.get("data")
                        or recent.get("summary")
                        or f"Reusing prior approval for {event.ticker}."
                    ),
                    oneline=one_line(
                        recent.get("oneline")
                        or recent.get("summary")
                        or f"Considering entry for {event.ticker}"
                    ),
                    confidence=clamp_confidence(recent.get("confidence")),
                    tier=event.tier.value,
                    run_id=event.id,
                    ticker=event.ticker,
                    event_type="orchestrator",
                )
                return True
            return False
        snapshot = self.snapshot.hydrate()
        timeout = float(
            config.get(
                "fast_reasoning_timeout_seconds",
                DEFAULT_CONFIG["fast_reasoning_timeout_seconds"],
            )
        )
        results = await self._spawn_subagents(event, snapshot, timeout)
        fallback_action = self._recommend(event, results)
        llm_decision = await self._ask_llm(session, event, results, timeout)
        action = (llm_decision or {}).get("action", fallback_action)
        self._emit_orchestrator_response(event, results, llm_decision, fallback_action)
        return action == "CONSIDER_ENTRY"

    async def _spawn_subagents(
        self, event: AgentEvent, snapshot: dict[str, Any], timeout: float
    ) -> list[Any]:
        """Spawn the short-lived sub-agents an event calls for.

        Each sub-agent is surfaced in the Agents Status panel (active -> done) and
        returns the {data, oneline, confidence} agent contract as a session event.
        """
        if self.snapshot.subagents_halted():
            return []
        names = self.dispatcher._analysts_for(event.type.value)
        spawn_id = uuid.uuid4().hex[:8]
        sub_ids: dict[str, str] = {}
        for name in names:
            sub_id = f"{spawn_id}:{name}"
            sub_ids[name] = sub_id
            label = SUBAGENT_LABELS.get(name, name.replace("_", " ").title())
            try:
                self.snapshot.record_subagent(
                    sub_id=sub_id,
                    name=label,
                    tier=event.tier.value,
                    ticker=event.ticker,
                    oneline=f"Analyzing {event.type.value.replace('_', ' ')}"
                    + (f" for {event.ticker}" if event.ticker else ""),
                    run_id=event.id,
                )
            except Exception:
                pass

        results = await self.dispatcher.dispatch(
            event, snapshot, timeout_seconds=timeout
        )
        by_name = {result.analyst: result for result in results}
        for name in names:
            result = by_name.get(name)
            if result is None:
                continue
            label = SUBAGENT_LABELS.get(name, name.replace("_", " ").title())
            oneline = f"{result.verdict.replace('_', ' ').title()} — {label}"
            confidence = clamp_confidence(result.confidence)
            data = plain_text(
                f"{result.summary}\n"
                f"Verdict: {result.verdict}. Factors: {', '.join(result.factors) or 'n/a'}."
            )
            try:
                self.snapshot.finish_subagent(
                    sub_ids[name],
                    oneline=oneline,
                    data=data,
                    confidence=confidence,
                    status="done" if not result.fallback else "degraded",
                )
            except Exception:
                pass
            emit_agent_response(
                self.store,
                self.session_id,
                agent=label,
                data=data,
                oneline=oneline,
                confidence=confidence,
                tier=event.tier.value,
                run_id=event.id,
                ticker=event.ticker,
                event_type="subagent",
            )
        return results

    def _emit_orchestrator_response(
        self,
        event: AgentEvent,
        analyst_results: list[Any],
        llm_decision: dict[str, str] | None,
        fallback_action: str,
    ) -> dict[str, Any]:
        """Emit the orchestrator's {data, oneline, confidence} response + keep a recommendation."""
        action = (llm_decision or {}).get("action", fallback_action)
        label = ACTION_LABELS.get(action, action.replace("_", " ").title())
        analyst_summary = "; ".join(
            f"{SUBAGENT_LABELS.get(r.analyst, r.analyst)}: {r.verdict}"
            for r in analyst_results
        )
        summary = (llm_decision or {}).get("summary") or "; ".join(
            r.summary for r in analyst_results
        )
        confidence = clamp_confidence(
            sum(r.confidence for r in analyst_results) / max(1, len(analyst_results))
        )
        ticker_note = f" for {event.ticker}" if event.ticker else ""
        oneline = one_line(f"{label}{ticker_note}")
        data = plain_text(
            f"{label}{ticker_note} on {event.type.value.replace('_', ' ')}.\n"
            f"{summary}\n"
            f"Sub-agent consensus: {analyst_summary or 'deterministic controls only'}."
        )
        recommendation = {
            "id": event.id,
            "created_at": _now(),
            "ticker": event.ticker,
            "event_type": event.type.value,
            "tier": event.tier.value,
            "action": action,
            "summary": summary,
            "confidence": round(confidence, 3),
            "analysts": [r.to_dict() for r in analyst_results],
            "provenance": "main_orchestrator",
            "fallback": llm_decision is None,
            "data": data,
            "oneline": oneline,
        }
        self.snapshot.mutate(
            lambda state: (
                state.setdefault("recommendations", []).append(recommendation),
                state["recommendations"].__setitem__(
                    slice(None, max(0, len(state["recommendations"]) - 30)), []
                ),
            )
        )
        return emit_agent_response(
            self.store,
            self.session_id,
            agent="main_orchestrator",
            data=data,
            oneline=oneline,
            confidence=confidence,
            tier=event.tier.value,
            run_id=event.id,
            ticker=event.ticker,
            event_type="agent_response",
        )

    def _within_budget(self, config: dict[str, Any], event: AgentEvent) -> bool:
        now = time.monotonic()
        while self._wakeups and now - self._wakeups[0] > 3600:
            self._wakeups.popleft()
        budget = int(config.get("orchestrator_wakeups_per_hour", 30))
        cooldown = float(config.get("orchestrator_cooldown_seconds", 10))
        last = self._last_by_type.get(event.type.value)
        if len(self._wakeups) >= budget or (last is not None and now - last < cooldown):
            return False
        self._wakeups.append(now)
        self._last_by_type[event.type.value] = now
        return True

    @staticmethod
    def _recommend(event: AgentEvent, results: list[Any]) -> str:
        verdicts = {result.verdict for result in results}
        if event.type == EventType.CRITICAL_NEWS or "adverse" in verdicts:
            return "REVIEW_EXIT"
        if event.type == EventType.REBUY_CANDIDATE:
            return "CONSIDER_ENTRY"
        if event.type in {
            EventType.PROFIT_LEVEL_HIT,
            EventType.PROFIT_SECURED,
            EventType.PROFIT_STALL_TRIM,
        }:
            return "PROTECT_POSITION"
        if event.type == EventType.POSITION_WEAKENING:
            return "PROTECT_POSITION"
        if event.type in {EventType.STRATEGY_REVIEW, EventType.BROKER_DRIFT}:
            slots = event.payload.get("open_watchlist_slots") or []
            headroom = float(event.payload.get("headroom_usd") or 0)
            if slots and headroom >= float(DEFAULT_CONFIG["min_allocation_usd"]):
                return "CONSIDER_ENTRY"
            return "HOLD"
        if event.type == EventType.CANDIDATE_FOUND and "capacity_constrained" not in verdicts:
            return "CONSIDER_ENTRY"
        return "HOLD"

    def _service_state(self, status: str, work: str) -> None:
        def update(state: dict[str, Any]) -> None:
            service = state.setdefault("services", {}).setdefault("main_orchestrator", {})
            service.update(
                {
                    "name": "main_orchestrator",
                    "kind": "llm",
                    "status": status,
                    "current_work": work,
                    "last_run_at": _now(),
                }
            )
            state.setdefault("agent_state", {})["orchestrator"] = status
            state["agent_state"]["last_wakeup_at"] = _now()
            state["agent_state"]["wakeups_last_hour"] = len(self._wakeups)

        self.snapshot.mutate(update)

    async def _ask_llm(
        self,
        session: dict[str, Any],
        event: AgentEvent,
        analyst_results: list[Any],
        timeout: float,
    ) -> dict[str, str] | None:
        from control_plane.agentic.agent_reasoning import _cursor_enabled

        if not _cursor_enabled():
            return None
        from control_plane.agentic.agent_store_adapter import AgenticAgentStoreAdapter
        from control_plane.agentic.agent_stream import stream_agentic_prompt

        prompt = (
            "You are the single persistent trading orchestrator. Consume the event and the "
            "short-lived analyst outputs below — they are complete; do NOT read the codebase or "
            "use tools. Return JSON only: "
            '{"action":"CONSIDER_ENTRY|HOLD|PROTECT_POSITION|REVIEW_EXIT",'
            '"summary":"one concise trader-facing sentence"}. Never place orders or weaken '
            f"deterministic risk controls. Event={event.to_dict()} "
            f"Analysts={[result.to_dict() for result in analyst_results]}"
        )
        adapter = AgenticAgentStoreAdapter(
            self.store, agent="main_orchestrator", suppress_thinking_stream=True
        )
        try:
            raw = await asyncio.wait_for(
                stream_agentic_prompt(
                    session_id=self.session_id,
                    store=adapter,
                    state="orchestrating",
                    prompt=prompt,
                    interaction_mode="analyze",
                    web_search_enabled=False,
                ),
                timeout=timeout,
            )
            match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
            if not match:
                return None
            parsed = json.loads(match.group(0))
            action = str(parsed.get("action") or "").upper()
            allowed = {
                "CONSIDER_ENTRY",
                "HOLD",
                "PROTECT_POSITION",
                "REVIEW_EXIT",
            }
            if action not in allowed:
                return None
            if event.type == EventType.CANDIDATE_FOUND and action not in {
                "CONSIDER_ENTRY",
                "HOLD",
            }:
                action = "HOLD"
            return {
                "action": action,
                "summary": str(parsed.get("summary") or "Structured decision completed")[:240],
            }
        except (asyncio.TimeoutError, Exception):
            return None
