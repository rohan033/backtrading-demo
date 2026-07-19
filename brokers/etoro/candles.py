"""eToro historical OHLCV candles (OpenAPI market-data).

The candles endpoint is path-only (no fromDate/toDate query params):
  GET .../history/candles/{direction}/{interval}/{candlesCount}

We paginate backwards by defining a [start, end) window, fetching desc from now,
filtering client-side, then using the earliest returned bar as the next `end`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from logzero import logger

CANDLE_INTERVAL_ONE_MINUTE = "OneMinute"
MAX_CANDLE_COUNT = 1000
DEFAULT_CANDLE_COUNT = MAX_CANDLE_COUNT
BOOTSTRAP_CANDLE_COUNT = MAX_CANDLE_COUNT
SYNC_CANDLE_COUNT = MAX_CANDLE_COUNT
CANDLE_HISTORY_2H_MINUTES = 120
DEFAULT_HISTORY_PAGE_COUNT = 100

# Used only when OneMinute desc cannot reach the requested window (eToro max 1000 bars).
CANDLE_INTERVALS: tuple[tuple[str, int], ...] = (
    (CANDLE_INTERVAL_ONE_MINUTE, 60),
    ("FiveMinutes", 300),
    ("TenMinutes", 600),
    ("FifteenMinutes", 900),
    ("ThirtyMinutes", 1800),
    ("OneHour", 3600),
    ("FourHours", 14400),
    ("OneDay", 86400),
)


def _first_value(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def _parse_candle_time(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        value = int(raw)
        return value if value > 1_000_000_000 else None
    text = str(raw).strip()
    if not text:
        return None
    if text.isdigit():
        value = int(text)
        return value if value > 1_000_000_000 else None
    normalized = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def normalize_etoro_candle(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    candle_time = _parse_candle_time(
        _first_value(raw, "fromDate", "FromDate", "date", "Date", "time", "Time", "timestamp", "Timestamp")
    )
    open_price = _first_value(raw, "open", "Open", "openRate", "OpenRate")
    high = _first_value(raw, "high", "High", "highRate", "HighRate")
    low = _first_value(raw, "low", "Low", "lowRate", "LowRate")
    close = _first_value(raw, "close", "Close", "closeRate", "CloseRate", "lastExecution", "LastExecution")
    volume = _first_value(raw, "volume", "Volume", "totalVolume", "TotalVolume") or 0

    try:
        open_f = float(open_price)
        high_f = float(high)
        low_f = float(low)
        close_f = float(close)
        volume_f = float(volume)
    except (TypeError, ValueError):
        return None

    if candle_time is None or min(open_f, high_f, low_f, close_f) <= 0:
        return None

    candle_time = (candle_time // 60) * 60
    return {
        "time": candle_time,
        "open": open_f,
        "high": max(high_f, open_f, low_f, close_f),
        "low": min(low_f, open_f, high_f, close_f),
        "close": close_f,
        "volume": volume_f,
    }


def _flatten_candle_rows(rows: list[Any]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        nested = row.get("candles") or row.get("Candles")
        if isinstance(nested, list) and nested:
            flattened.extend(item for item in nested if isinstance(item, dict))
            continue
        flattened.append(row)
    return flattened


def extract_etoro_candles(response: Any) -> list[dict[str, Any]]:
    if not isinstance(response, dict):
        return []

    rows = (
        response.get("candles")
        or response.get("Candles")
        or response.get("items")
        or response.get("data")
        or []
    )
    if not isinstance(rows, list):
        return []

    candles: list[dict[str, Any]] = []
    for row in _flatten_candle_rows(rows):
        candle = normalize_etoro_candle(row)
        if candle is not None:
            candles.append(candle)
    deduped = {candle["time"]: candle for candle in candles}
    result = sorted(deduped.values(), key=lambda item: item["time"])
    # if result:
        # logger.debug(
        #     "[eToro] Parsed %d candles (%d with volume > 0)",
        #     len(result),
        #     sum(1 for candle in result if float(candle.get("volume") or 0) > 0),
        # )
    return result


def _minute_bucket(ts: float | None = None) -> int:
    import time

    value = int(ts if ts is not None else time.time())
    return (value // 60) * 60


def _align_minute(ts: int) -> int:
    return (int(ts) // 60) * 60


def compute_candle_fetch_count(
    *,
    before_time: int,
    minutes: int,
    now: int | None = None,
    interval_seconds: int = 60,
) -> int:
    """How many desc candles to request to cover a window ending at `before_time`."""
    end_time = _align_minute(before_time)
    start_time = end_time - max(1, min(int(minutes), 1000)) * 60
    return compute_desc_fetch_count_for_window(
        start_time=start_time,
        end_time=end_time,
        now=now,
        interval_seconds=interval_seconds,
    )


def compute_desc_fetch_count_for_window(
    *,
    start_time: int,
    end_time: int,
    now: int | None = None,
    interval_seconds: int = 60,
) -> int:
    """Bars to request (desc from now) so the response likely covers [start, end)."""
    now_bucket = _minute_bucket(now)
    end = _align_minute(end_time)
    start = _align_minute(start_time)
    safe_interval = max(60, int(interval_seconds))
    bars_from_now_to_end = max(0, (now_bucket - end) // safe_interval)
    window_bars = max(1, (max(end - start, safe_interval) + safe_interval - 1) // safe_interval)
    return min(bars_from_now_to_end + window_bars + 10, MAX_CANDLE_COUNT)


def select_candles_in_window(
    candles: list[dict[str, Any]],
    *,
    start_time: int,
    end_time: int,
    max_count: int | None = None,
) -> list[dict[str, Any]]:
    """Return ascending candles with start_time <= time < end_time."""
    start = _align_minute(start_time)
    end = _align_minute(end_time)
    in_window = [candle for candle in candles if start <= int(candle["time"]) < end]
    in_window.sort(key=lambda item: item["time"])
    if max_count is not None and max_count > 0 and len(in_window) > max_count:
        return in_window[-max_count:]
    return in_window


def select_candles_before(
    candles: list[dict[str, Any]],
    before_time: int,
    minutes: int,
) -> list[dict[str, Any]]:
    """Keep bars in [before-minutes, before) — backwards-compatible helper."""
    end = _align_minute(before_time)
    start = end - max(1, min(int(minutes), 1000)) * 60
    return select_candles_in_window(
        candles,
        start_time=start,
        end_time=end,
        max_count=minutes,
    )


async def aget_historical_candles_window(
    client: Any,
    instrument_id: str | int,
    *,
    start_time: int,
    end_time: int,
    count: int = DEFAULT_HISTORY_PAGE_COUNT,
    interval: str = CANDLE_INTERVAL_ONE_MINUTE,
    interval_seconds: int = 60,
) -> tuple[list[dict[str, Any]], str]:
    """Fetch up to `count` candles in [start_time, end_time).

    eToro has no start/end API params — we fetch desc (or asc fallback) and filter.
    """
    safe_count = max(1, min(int(count), MAX_CANDLE_COUNT))
    start = _align_minute(start_time)
    end = _align_minute(end_time)
    if end <= start:
        return [], interval

    fetch_count = compute_desc_fetch_count_for_window(
        start_time=start,
        end_time=end,
        interval_seconds=interval_seconds,
    )

    async def _fetch(direction: str) -> list[dict[str, Any]]:
        candles = await aget_historical_candles(
            client,
            instrument_id,
            interval=interval,
            count=fetch_count if direction == "desc" else MAX_CANDLE_COUNT,
            direction=direction,
        )
        return select_candles_in_window(
            candles,
            start_time=start,
            end_time=end,
            max_count=safe_count,
        )

    window = await _fetch("desc")
    if window:
        # logger.info(
        #     "[eToro] Window candles start=%d end=%d interval=%s desc fetch=%d returned=%d",
        #     start,
        #     end,
        #     interval,
        #     fetch_count,
        #     len(window),
        # )
        return window, interval

    window = await _fetch("asc")
    if window:
        # logger.info(
        #     "[eToro] Window candles start=%d end=%d interval=%s asc fetch=%d returned=%d",
        #     start,
        #     end,
        #     interval,
        #     MAX_CANDLE_COUNT,
        #     len(window),
        # )
        return window, interval

    return [], interval


async def aget_historical_candles_before(
    client: Any,
    instrument_id: str | int,
    *,
    before_time: int,
    minutes: int = CANDLE_HISTORY_2H_MINUTES,
    count: int = DEFAULT_HISTORY_PAGE_COUNT,
    interval: str = CANDLE_INTERVAL_ONE_MINUTE,
) -> tuple[list[dict[str, Any]], str]:
    """Page backwards: end=before_time, start=before-minutes, up to `count` bars."""
    safe_minutes = max(1, min(int(minutes), 1000))
    end = _align_minute(before_time)
    start = end - safe_minutes * 60
    safe_count = max(1, min(int(count), safe_minutes, MAX_CANDLE_COUNT))

    for interval_name, interval_seconds in CANDLE_INTERVALS:
        window, used_interval = await aget_historical_candles_window(
            client,
            instrument_id,
            start_time=start,
            end_time=end,
            count=safe_count,
            interval=interval_name,
            interval_seconds=interval_seconds,
        )
        if window:
            return window, used_interval

    # logger.info(
    #     "[eToro] Historical candles before=%d minutes=%d count=%d returned=0",
    #     end,
    #     safe_minutes,
    #     safe_count,
    # )
    return [], interval


async def aget_historical_candles(
    client: Any,
    instrument_id: str | int,
    *,
    interval: str = CANDLE_INTERVAL_ONE_MINUTE,
    count: int = DEFAULT_CANDLE_COUNT,
    direction: str = "desc",
) -> list[dict[str, Any]]:
    safe_count = max(1, min(int(count), MAX_CANDLE_COUNT))
    safe_direction = "asc" if str(direction).lower() == "asc" else "desc"
    path = (
        f"/market-data/instruments/{instrument_id}/history/candles/"
        f"{safe_direction}/{interval}/{safe_count}"
    )
    response = await client.arequest("GET", path)
    candles = extract_etoro_candles(response)
    # logger.info(
    #     "[eToro] Historical candles instrument=%s interval=%s count=%d returned=%d",
    #     instrument_id,
    #     interval,
    #     safe_count,
    #     len(candles),
    # )
    return candles
