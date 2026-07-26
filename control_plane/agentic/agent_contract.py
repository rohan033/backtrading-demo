"""Shared agent/monitor response contracts for the agentic dashboard.

Two contracts flow through the whole agentic path — no A2UI / A2UI surfaces
anywhere:

1. Deterministic monitors publish/return::

       {"data": {...}, "should_spawn_sub_agent": true | false}

   When ``should_spawn_sub_agent`` is true the monitor is asking the MAIN
   orchestrator to spawn the appropriate short-lived sub-agent. Critical
   deterministic risk events (hard stop / max daily loss / margin) bypass the
   LLM entirely and never require spawning.

2. Every agent (orchestrator + spawned sub-agents) returns::

       {"data": "<2-3 line plain-text summary>",
        "oneline": "<one line status of what was/will be done>",
        "confidence": 0.0 .. 1.0}

   These are persisted as session events with clear provenance
   (agent name, tier, run_id). The one-line drives the Log row; ``data`` +
   ``confidence`` show inside the expandable accordion body.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def plain_text(value: Any, *, max_lines: int = 3, max_len: int = 320) -> str:
    """Strip markdown / JSON noise; clamp to a short plain-text blurb."""
    text = str(value or "")
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"[*_`#>]+", "", text)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    joined = " ".join(lines[:max_lines]) if max_lines <= 1 else "\n".join(lines[:max_lines])
    if len(joined) > max_len:
        joined = joined[: max_len - 1].rstrip() + "…"
    return joined


def one_line(value: Any, *, max_len: int = 140) -> str:
    text = re.sub(r"\s+", " ", plain_text(value, max_lines=1, max_len=max_len + 40)).strip()
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


def clamp_confidence(value: Any) -> float:
    try:
        conf = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, conf))


@dataclass
class MonitorResult:
    """Deterministic monitor contract: {"data": {...}, "should_spawn_sub_agent": bool}."""

    data: dict[str, Any] = field(default_factory=dict)
    should_spawn_sub_agent: bool = False
    status: str = "active"
    oneline: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "data": dict(self.data),
            "should_spawn_sub_agent": bool(self.should_spawn_sub_agent),
        }


@dataclass
class AgentResponse:
    """Agent contract: {"data": str, "oneline": str, "confidence": float}."""

    data: str
    oneline: str
    confidence: float
    agent: str
    tier: str | None = None
    run_id: str | None = None
    ticker: str | None = None

    def to_meta(self) -> dict[str, Any]:
        return {
            "kind": "agent_response",
            "agent": self.agent,
            "provenance": self.agent,
            "tier": self.tier,
            "run_id": self.run_id,
            "data": self.data,
            "oneline": self.oneline,
            "confidence": self.confidence,
        }


def emit_agent_response(
    store: Any,
    session_id: str,
    *,
    agent: str,
    data: Any,
    oneline: Any,
    confidence: Any,
    tier: str | None = None,
    run_id: str | None = None,
    ticker: str | None = None,
    event_type: str = "agent_response",
) -> dict[str, Any]:
    """Persist an agent response event carrying the {data, oneline, confidence} contract."""
    response = AgentResponse(
        data=plain_text(data),
        oneline=one_line(oneline) or one_line(data),
        confidence=clamp_confidence(confidence),
        agent=agent,
        tier=tier,
        run_id=run_id,
        ticker=ticker,
    )
    meta = response.to_meta()
    meta["created_at"] = _now()
    return store.add_event(
        session_id,
        event_type,
        response.oneline or response.data or agent,
        ticker=ticker,
        meta=meta,
    )
