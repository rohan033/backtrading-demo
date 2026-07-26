"""Short-lived structured analyst tasks with deterministic fallbacks."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class AnalystResult:
    analyst: str
    verdict: str
    confidence: float
    summary: str
    factors: list[str]
    fallback: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AnalystDispatcher:
    """Dispatches bounded, short-lived analysts; every path returns structured data."""

    async def dispatch(
        self,
        event: Any,
        snapshot: dict[str, Any],
        *,
        timeout_seconds: float,
    ) -> list[AnalystResult]:
        names = self._analysts_for(event.type.value)
        tasks = [asyncio.create_task(self._run(name, event, snapshot)) for name in names]
        try:
            return await asyncio.wait_for(asyncio.gather(*tasks), timeout=timeout_seconds)
        except (asyncio.TimeoutError, Exception):
            for task in tasks:
                task.cancel()
            return [self._fallback(name, event) for name in names]

    @staticmethod
    def _analysts_for(event_type: str) -> tuple[str, ...]:
        if event_type == "candidate_found":
            return ("momentum_analyst", "portfolio_impact_analyst")
        if event_type == "critical_news":
            return ("news_analyst", "exit_planner")
        if event_type in ("position_weakening", "playbook_review", "profit_level_hit", "profit_secured"):
            return ("momentum_analyst", "exit_planner")
        if event_type == "rebuy_candidate":
            return ("momentum_analyst", "portfolio_impact_analyst")
        return ("portfolio_impact_analyst",)

    async def _run(
        self, name: str, event: Any, snapshot: dict[str, Any]
    ) -> AnalystResult:
        """Deterministic first-pass analyst; replaceable with a bounded model adapter."""
        await asyncio.sleep(0)
        payload = event.payload
        score = float(payload.get("score") or 50)
        exposure = float((snapshot.get("portfolio") or {}).get("exposure_pct") or 0)
        if name == "momentum_analyst":
            verdict = "favorable" if score >= 60 else "neutral"
            summary = f"Momentum score {score:.0f}; structure requires normal stop discipline."
            factors = [f"candidate_score={score:.1f}"]
            confidence = min(0.95, max(0.4, score / 100))
        elif name == "news_analyst":
            verdict = "adverse"
            summary = str(payload.get("headline") or "Critical company news detected")
            factors = list(payload.get("critical_keywords") or [])
            confidence = 0.85
        elif name == "exit_planner":
            verdict = "protect"
            lock = event.payload.get("profit_lock")
            level = event.payload.get("level_id")
            if event.type.value == "rebuy_candidate":
                verdict = "defer"
                summary = str(event.payload.get("reason") or "Rebuy scan only — entries stay orchestrator-gated.")
            elif level:
                summary = (
                    f"Profit level {level} reached — trimmed per ladder; "
                    "profit lock remains ratcheted."
                )
            elif lock:
                summary = (
                    f"Profit lock at {float(lock):.4f} secured gains; "
                    "hard stop still applies underneath."
                )
            else:
                summary = "Dynamic profit ladder armed from recent highs; hard stop unchanged."
            factors = ["profit_ladder", "hard_stop_immutable", "at_most_once_execution"]
            if lock:
                factors.append(f"profit_lock={lock}")
            confidence = 0.9
        else:
            headroom = float(event.payload.get("headroom_usd") or 0)
            slots = event.payload.get("open_watchlist_slots") or []
            if slots and headroom >= 20:
                verdict = "capacity_available"
                summary = (
                    f"Portfolio has ${headroom:.0f} headroom; watchlist slots open: "
                    f"{', '.join(str(s) for s in slots[:4])}."
                )
            elif exposure < 80:
                verdict = "capacity_available"
                summary = f"Portfolio exposure is {exposure:.1f}%."
            else:
                verdict = "capacity_constrained"
                summary = f"Portfolio exposure is {exposure:.1f}%."
            factors = [
                f"exposure_pct={exposure:.2f}",
                f"headroom_usd={headroom:.2f}",
            ]
            if slots:
                factors.append(f"open_slots={','.join(str(s) for s in slots[:6])}")
            confidence = 0.9
        return AnalystResult(name, verdict, confidence, summary, factors)

    @staticmethod
    def _fallback(name: str, event: Any) -> AnalystResult:
        return AnalystResult(
            analyst=name,
            verdict="defer",
            confidence=0.0,
            summary=f"{name.replace('_', ' ').title()} timed out; deterministic controls remain active.",
            factors=[event.type.value],
            fallback=True,
        )
