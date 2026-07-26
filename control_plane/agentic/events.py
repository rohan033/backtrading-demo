"""Typed event envelopes and bounded per-session event buses."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class EventTier(str, Enum):
    CRITICAL = "critical"
    FAST = "fast"
    STRATEGIC = "strategic"
    OBSERVATION = "observation"


class EventType(str, Enum):
    CANDIDATE_FOUND = "candidate_found"
    POSITION_WEAKENING = "position_weakening"
    CRITICAL_NEWS = "critical_news"
    STOP_LOSS = "stop_loss"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    EXPOSURE_LIMIT = "exposure_limit"
    BROKER_DRIFT = "broker_drift"
    STRATEGY_REVIEW = "strategy_review"
    PLAYBOOK_REVIEW = "playbook_review"
    PROFIT_LEVEL_HIT = "profit_level_hit"
    PROFIT_SECURED = "profit_secured"
    REBUY_CANDIDATE = "rebuy_candidate"
    SERVICE_STATUS = "service_status"


@dataclass(frozen=True)
class AgentEvent:
    session_id: str
    type: EventType
    tier: EventTier
    source: str
    payload: dict[str, Any] = field(default_factory=dict)
    ticker: str | None = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    dedupe_key: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["type"] = self.type.value
        value["tier"] = self.tier.value
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentEvent":
        return cls(
            session_id=str(value["session_id"]),
            type=EventType(value["type"]),
            tier=EventTier(value["tier"]),
            source=str(value.get("source") or "unknown"),
            payload=dict(value.get("payload") or {}),
            ticker=value.get("ticker"),
            id=str(value.get("id") or uuid.uuid4().hex),
            created_at=str(value.get("created_at") or datetime.now(timezone.utc).isoformat()),
            dedupe_key=value.get("dedupe_key"),
        )


def event_fingerprint(event: AgentEvent) -> str:
    if event.dedupe_key:
        return event.dedupe_key
    raw = json.dumps(
        [event.type.value, event.ticker, event.source, event.payload],
        sort_keys=True,
        default=str,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


class SessionEventBus:
    def __init__(self, session_id: str, store: Any, maxsize: int = 200) -> None:
        self.session_id = session_id
        self.store = store
        self.queue: asyncio.PriorityQueue[tuple[int, int, AgentEvent]] = asyncio.PriorityQueue(
            maxsize=max(10, maxsize)
        )
        self._sequence = 0
        self._seen: dict[str, float] = {}

    async def publish(self, event: AgentEvent, *, dedupe_seconds: float = 120.0) -> bool:
        now = time.monotonic()
        fingerprint = event_fingerprint(event)
        last = self._seen.get(fingerprint)
        if last is not None and now - last < dedupe_seconds:
            return False
        self._seen[fingerprint] = now
        self._seen = {key: value for key, value in self._seen.items() if now - value < 3600}
        self.store.add_event(
            event.session_id,
            "agent_event",
            f"{event.source}: {event.type.value.replace('_', ' ')}",
            ticker=event.ticker,
            meta={
                "envelope": event.to_dict(),
                "provenance": event.source,
                "tier": event.tier.value,
            },
        )
        priority = {
            EventTier.CRITICAL: 0,
            EventTier.FAST: 1,
            EventTier.STRATEGIC: 2,
            EventTier.OBSERVATION: 3,
        }[event.tier]
        self._sequence += 1
        item = (priority, self._sequence, event)
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        await self.queue.put(item)
        return True

    async def next(self) -> AgentEvent:
        return (await self.queue.get())[2]


class EventBusRegistry:
    def __init__(self) -> None:
        self._buses: dict[str, SessionEventBus] = {}

    def get(self, session_id: str, store: Any, maxsize: int = 200) -> SessionEventBus:
        bus = self._buses.get(session_id)
        if bus is None:
            bus = SessionEventBus(session_id, store, maxsize)
            self._buses[session_id] = bus
        return bus

    def remove(self, session_id: str) -> None:
        self._buses.pop(session_id, None)


_registry = EventBusRegistry()


def get_event_bus(session_id: str, store: Any, maxsize: int = 200) -> SessionEventBus:
    return _registry.get(session_id, store, maxsize)


def remove_event_bus(session_id: str) -> None:
    _registry.remove(session_id)
