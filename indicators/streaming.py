from collections import deque
from dataclasses import dataclass

from .core import bollinger_bands, rsi


@dataclass(frozen=True)
class IndicatorSnapshot:
    rsi: float | None
    bb_middle: float | None
    bb_upper: float | None
    bb_lower: float | None
    price_count: int
    ready: bool

    @property
    def rsi_ready(self) -> bool:
        return self.rsi is not None

    @property
    def bb_ready(self) -> bool:
        return self.bb_middle is not None


class StreamingIndicators:
    """
    Incremental RSI + Bollinger over incoming tick prices (LTP series).
    Each tick is treated as a new close; use tick_sample_every on the executor
    to reduce noise if the feed is very fast.
    """

    def __init__(
        self,
        *,
        rsi_period: int = 14,
        bb_period: int = 20,
        bb_std: float = 2.0,
        max_prices: int = 500,
    ):
        self.rsi_period = max(1, rsi_period)
        self.bb_period = max(1, bb_period)
        self.bb_std = bb_std
        min_window = max(self.rsi_period + 1, self.bb_period)
        self._prices: deque[float] = deque(maxlen=max(max_prices, min_window))

    def seed(self, price: float) -> IndicatorSnapshot:
        self._prices.clear()
        return self.update(price)

    def update(self, price: float) -> IndicatorSnapshot:
        self._prices.append(float(price))
        prices = list(self._prices)
        rsi_val = rsi(prices, self.rsi_period)
        bb = bollinger_bands(prices, self.bb_period, self.bb_std)
        bb_middle = bb_upper = bb_lower = None
        if bb is not None:
            bb_middle, bb_upper, bb_lower = bb
        ready = rsi_val is not None and bb is not None
        return IndicatorSnapshot(
            rsi=rsi_val,
            bb_middle=bb_middle,
            bb_upper=bb_upper,
            bb_lower=bb_lower,
            price_count=len(self._prices),
            ready=ready,
        )
