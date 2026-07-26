"""Rolling short-window price samples for 30s (etc.) profit high/low tracking."""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _PriceSample:
    ts: float
    price: float


@dataclass
class _TickerSeries:
    samples: deque[_PriceSample] = field(default_factory=deque)


class ProfitPriceTracker:
    """In-memory quote ring buffer per session ticker (not persisted)."""

    def __init__(self, *, retention_seconds: float = 120.0) -> None:
        self._retention_seconds = max(30.0, float(retention_seconds))
        self._series: dict[tuple[str, str], _TickerSeries] = {}
        self._lock = threading.Lock()

    def record(
        self,
        session_id: str,
        ticker: str,
        price: float,
        *,
        ts: float | None = None,
        source: str = "websocket",
    ) -> None:
        value = float(price)
        if value <= 0:
            return
        key = (str(session_id), str(ticker).upper())
        stamp = float(ts if ts is not None else time.time())
        with self._lock:
            series = self._series.setdefault(key, _TickerSeries())
            series.samples.append(_PriceSample(ts=stamp, price=value))
            self._trim(series, stamp)

    def window_stats(
        self,
        session_id: str,
        ticker: str,
        *,
        window_seconds: float,
        current_price: float | None = None,
    ) -> dict[str, Any]:
        key = (str(session_id), str(ticker).upper())
        window = max(5.0, float(window_seconds))
        cutoff = time.time() - window
        prices: list[float] = []
        with self._lock:
            series = self._series.get(key)
            if series:
                self._trim(series, time.time())
                prices = [sample.price for sample in series.samples if sample.ts >= cutoff]
        if current_price is not None and float(current_price) > 0:
            prices.append(float(current_price))
        if not prices:
            return {
                "recent_high": None,
                "recent_low": None,
                "sample_count": 0,
                "closes": [],
            }
        return {
            "recent_high": max(prices),
            "recent_low": min(prices),
            "sample_count": len(prices),
            "closes": prices[-max(6, min(12, len(prices))) :],
        }

    def clear_session(self, session_id: str) -> None:
        with self._lock:
            for key in list(self._series):
                if key[0] == str(session_id):
                    del self._series[key]

    def _trim(self, series: _TickerSeries, now: float) -> None:
        cutoff = now - self._retention_seconds
        while series.samples and series.samples[0].ts < cutoff:
            series.samples.popleft()


_tracker = ProfitPriceTracker()


def get_profit_price_tracker() -> ProfitPriceTracker:
    return _tracker
