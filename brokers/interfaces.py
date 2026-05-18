from dataclasses import dataclass
from typing import Protocol


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
