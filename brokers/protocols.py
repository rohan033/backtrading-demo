"""Broker and tick protocol definitions (canonical; prefer over brokers.interfaces)."""

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class TickData:
    symbol: str
    token: str
    ltp: float
    exchange: str


@dataclass
class Subscription:
    exchange: str
    symbol: str
    token: str


@dataclass
class LTPData:
    exchange: str
    symbol: str
    token: str
    ltp: float


@dataclass
class OrderActivity:
    activity_type: str
    order_id: str | None = None
    position_id: str | None = None
    status: str | None = None
    instrument_id: str | None = None
    source: str | None = None
    raw: dict[str, Any] | None = None


class TickClient(Protocol):
    async def aget_ltp_bulk(self, subscriptions: list[Subscription]) -> list[LTPData]:
        ...


class TickListener(Protocol):
    def enqueue_tick(self, tick: TickData) -> None:
        ...

    async def handle_tick(self, tick: TickData) -> None:
        ...

    def get_required_subscriptions(self) -> list[Subscription]:
        ...


class OrderActivityListener(Protocol):
    def enqueue_order_activity(self, activity: OrderActivity) -> None:
        ...

    async def handle_order_activity(self, activity: OrderActivity) -> None:
        ...
