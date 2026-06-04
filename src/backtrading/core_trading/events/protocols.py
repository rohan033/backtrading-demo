from __future__ import annotations

from typing import Any, Protocol


class EventSink(Protocol):
    async def handle(self, event: Any) -> None:
        ...
