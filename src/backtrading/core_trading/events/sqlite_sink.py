"""SQLite writer sink (runs sync DB work in executor)."""

from __future__ import annotations

import asyncio
from typing import Any

from backtrading.core_trading.events.bus import DomainEvent


class SqliteEventSink:
    def __init__(self, writer: Any) -> None:
        self._writer = writer

    async def handle(self, event: DomainEvent) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            lambda: self._writer.write_event(
                event.order_id,
                event.action,
                event.details,
            )
            if hasattr(self._writer, "write_event")
            else None,
        )
