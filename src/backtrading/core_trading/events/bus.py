"""Bounded async event bus (see docs/event-bus.md)."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from backtrading.core_trading.events.protocols import EventSink

log = logging.getLogger("backtrading.events")
DEFAULT_MAXSIZE = 1000


@dataclass(frozen=True)
class DomainEvent:
    action: str
    details: dict[str, Any] = field(default_factory=dict)
    order_id: str | None = None
    engine_id: str | None = None


class EventBus:
    def __init__(self, *, maxsize: int = DEFAULT_MAXSIZE) -> None:
        self._queue: asyncio.Queue[DomainEvent | None] = asyncio.Queue(maxsize=maxsize)
        self._sinks: list[EventSink] = []
        self._task: asyncio.Task | None = None
        self.dropped_total = 0

    def subscribe(self, sink: EventSink) -> None:
        self._sinks.append(sink)

    def emit(self, event: DomainEvent) -> None:
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped_total += 1
            log.warning("[EventBus] queue full; dropped action=%s", event.action)

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="event-bus")

    async def stop(self) -> None:
        if self._task is not None:
            await self._queue.put(None)
            await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            event = await self._queue.get()
            if event is None:
                break
            await asyncio.gather(
                *[self._dispatch_one(sink, event) for sink in self._sinks],
                return_exceptions=True,
            )

    async def _dispatch_one(self, sink: EventSink, event: DomainEvent) -> None:
        try:
            await asyncio.wait_for(sink.handle(event), timeout=5.0)
        except Exception as exc:
            log.warning("[EventBus] sink %s failed: %s", type(sink).__name__, exc)
