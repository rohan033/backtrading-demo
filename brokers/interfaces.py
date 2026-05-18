from dataclasses import dataclass
from typing import Protocol

from managers.tick_provider import TickData


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
    async def handle_tick(self, tick: TickData) -> None:
        ...
    
    def get_required_subscriptions(self) -> list[Subscription]:
        ...
