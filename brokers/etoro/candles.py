"""eToro historical OHLCV candles (OpenAPI market-data)."""

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

    # lightweight-charts minute bars use unix seconds aligned to minute.
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
    """eToro wraps minute bars inside instrument groups: { candles: [ {fromDate, open, ...}, ... ] }."""
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
    if result:
        logger.debug(
            "[eToro] Parsed %d candles (%d with volume > 0)",
            len(result),
            sum(1 for candle in result if float(candle.get("volume") or 0) > 0),
        )
    return result


def _minute_bucket(ts: float | None = None) -> int:
    import time

    value = int(ts if ts is not None else time.time())
    return (value // 60) * 60


def compute_candle_fetch_count(
    *,
    before_time: int,
    minutes: int,
    now: int | None = None,
) -> int:
    """How many desc candles to request to cover `minutes` bars older than `before_time`."""
    before = (int(before_time) // 60) * 60
    safe_minutes = max(1, min(int(minutes), 1000))
    now_bucket = _minute_bucket(now)
    bars_to_before = max(0, (now_bucket - before) // 60)
    return min(bars_to_before + safe_minutes + 10, 1000)


def select_candles_before(
    candles: list[dict[str, Any]],
    before_time: int,
    minutes: int,
) -> list[dict[str, Any]]:
    """Keep up to `minutes` one-minute bars strictly older than `before_time`."""
    before = (int(before_time) // 60) * 60
    safe_minutes = max(1, min(int(minutes), 1000))
    older = [candle for candle in candles if int(candle["time"]) < before]
    older.sort(key=lambda item: item["time"])
    if len(older) > safe_minutes:
        return older[-safe_minutes:]
    return older


async def aget_historical_candles_before(
    client: Any,
    instrument_id: str | int,
    *,
    before_time: int,
    minutes: int = CANDLE_HISTORY_2H_MINUTES,
    interval: str = CANDLE_INTERVAL_ONE_MINUTE,
) -> list[dict[str, Any]]:
    safe_minutes = max(1, min(int(minutes), 1000))
    fetch_count = compute_candle_fetch_count(before_time=before_time, minutes=safe_minutes)
    all_candles = await aget_historical_candles(
        client,
        instrument_id,
        interval=interval,
        count=fetch_count,
        direction="desc",
    )
    older = select_candles_before(all_candles, before_time, safe_minutes)
    logger.info(
        "[eToro] Historical candles before=%d minutes=%d fetch=%d returned=%d",
        (int(before_time) // 60) * 60,
        safe_minutes,
        fetch_count,
        len(older),
    )
    return older


async def aget_historical_candles(
    client: Any,
    instrument_id: str | int,
    *,
    interval: str = CANDLE_INTERVAL_ONE_MINUTE,
    count: int = DEFAULT_CANDLE_COUNT,
    direction: str = "desc",
) -> list[dict[str, Any]]:
    safe_count = max(1, min(int(count), 1000))
    safe_direction = "asc" if str(direction).lower() == "asc" else "desc"
    path = (
        f"/market-data/instruments/{instrument_id}/history/candles/"
        f"{safe_direction}/{interval}/{safe_count}"
    )
    response = await client.arequest("GET", path)
    candles = extract_etoro_candles(response)
    logger.info(
        "[eToro] Historical candles instrument=%s interval=%s count=%d returned=%d",
        instrument_id,
        interval,
        safe_count,
        len(candles),
    )
    return candles
