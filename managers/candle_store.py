"""In-memory 1-minute candle aggregation for live charts."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any


def minute_bucket(ts: float | None = None) -> int:
    value = int(ts if ts is not None else time.time())
    return (value // 60) * 60


@dataclass
class CandleBar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CandleBar | None:
        try:
            candle_time = int(data["time"])
            open_price = float(data["open"])
            high = float(data["high"])
            low = float(data["low"])
            close = float(data["close"])
            volume = float(data.get("volume") or 0)
        except (KeyError, TypeError, ValueError):
            return None
        if min(open_price, high, low, close) <= 0:
            return None
        return cls(
            time=(candle_time // 60) * 60,
            open=open_price,
            high=high,
            low=low,
            close=close,
            volume=volume,
        )


class CandleStore:
    """Keeps completed 1-minute bars plus the in-progress bar for one instrument."""

    def __init__(self, *, max_bars: int = 1100):
        self.max_bars = max_bars
        self._completed: dict[int, CandleBar] = {}
        self._forming: CandleBar | None = None

    def bars(self) -> list[dict[str, Any]]:
        items = list(self._completed.values())
        if self._forming is not None:
            items.append(self._forming)
        return [bar.to_dict() for bar in sorted(items, key=lambda item: item.time)]

    def apply_tick(self, ltp: float, *, ts: float | None = None) -> dict[str, Any]:
        price = float(ltp)
        if price <= 0:
            raise ValueError("ltp must be positive")

        bucket = minute_bucket(ts)
        if self._forming is not None and self._forming.time == bucket:
            self._forming.high = max(self._forming.high, price)
            self._forming.low = min(self._forming.low, price)
            self._forming.close = price
            if float(self._forming.volume or 0) <= 0:
                self._forming.volume += 1
            return self._forming.to_dict()

        previous_close = self._forming.close if self._forming is not None else None
        if self._forming is not None:
            self._completed[self._forming.time] = self._forming
            self._trim()
        elif self._completed:
            previous_close = self._completed[max(self._completed)].close

        open_price = previous_close if previous_close is not None else price
        self._forming = CandleBar(
            time=bucket,
            open=open_price,
            high=max(open_price, price),
            low=min(open_price, price),
            close=price,
            volume=0 if previous_close is not None else 1,
        )
        return self._forming.to_dict()

    def bootstrap(self, candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        self._completed.clear()
        self._forming = None
        bars: list[CandleBar] = []
        for candle in candles:
            bar = CandleBar.from_dict(candle)
            if bar is not None:
                bars.append(bar)
        bars.sort(key=lambda item: item.time)
        current_bucket = minute_bucket()
        if bars and bars[-1].time == current_bucket:
            self._forming = bars[-1]
            bars = bars[:-1]
        for bar in bars:
            self._completed[bar.time] = bar
        self._trim()
        return self.bars()

    def apply_sync(self, candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for candle in candles:
            bar = CandleBar.from_dict(candle)
            if bar is None:
                continue
            if self._forming is not None and bar.time >= self._forming.time:
                if bar.time == self._forming.time:
                    self._forming = bar
                continue
            self._completed[bar.time] = bar
        self._trim()
        return self.bars()

    def prepend_older(self, candles: list[dict[str, Any]]) -> int:
        """Insert completed bars older than the current forming bar. Returns count added."""
        added = 0
        for candle in candles:
            bar = CandleBar.from_dict(candle)
            if bar is None:
                continue
            if self._forming is not None and bar.time >= self._forming.time:
                continue
            if bar.time in self._completed:
                continue
            self._completed[bar.time] = bar
            added += 1
        self._trim()
        return added

    def oldest_time(self) -> int | None:
        bars = self.bars()
        return int(bars[0]["time"]) if bars else None

    def _trim(self) -> None:
        if len(self._completed) <= self.max_bars:
            return
        keep_times = sorted(self._completed)[-self.max_bars :]
        self._completed = {time: self._completed[time] for time in keep_times}
