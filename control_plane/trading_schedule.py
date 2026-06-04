from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
CEST = ZoneInfo("Europe/Berlin")

BROKER_MARKET_OPEN: dict[str, dict[str, Any]] = {
    "angel": {"tz": IST, "hour": 9, "minute": 15, "label": "IST 09:15"},
    "fake": {"tz": IST, "hour": 9, "minute": 15, "label": "IST 09:15"},
    # US cash session opens ~09:30 ET, which is 15:30 CEST (shown as 3:30 PM).
    "etoro": {"tz": CEST, "hour": 15, "minute": 30, "label": "CEST 3:30 PM"},
}


def normalize_broker(broker: str | None) -> str:
    value = str(broker or "angel").lower()
    if value == "fake":
        return "fake"
    if value == "etoro":
        return "etoro"
    return "angel"


def market_open_config(broker: str | None) -> dict[str, Any]:
    return BROKER_MARKET_OPEN[normalize_broker(broker)]


def is_trading_day(day: date) -> bool:
    return day.weekday() < 5


def next_trading_day(broker: str | None, *, from_dt: datetime | None = None) -> date:
    config = market_open_config(broker)
    tz = config["tz"]
    now = (from_dt or datetime.now(timezone.utc)).astimezone(tz)
    candidate = now.date()
    open_at = datetime.combine(candidate, time(config["hour"], config["minute"]), tzinfo=tz)
    if is_trading_day(candidate) and now < open_at:
        return candidate
    candidate += timedelta(days=1)
    while not is_trading_day(candidate):
        candidate += timedelta(days=1)
    return candidate


def scheduled_start_at(broker: str | None, trading_day: date) -> datetime:
    if not is_trading_day(trading_day):
        raise ValueError(f"{trading_day.isoformat()} is not a trading day")
    config = market_open_config(broker)
    tz = config["tz"]
    local_dt = datetime.combine(
        trading_day,
        time(config["hour"], config["minute"]),
        tzinfo=tz,
    )
    return local_dt.astimezone(timezone.utc)


def upcoming_trading_days(
    broker: str | None,
    count: int = 4,
    *,
    from_dt: datetime | None = None,
) -> list[date]:
    if count < 1:
        return []

    days = [next_trading_day(broker, from_dt=from_dt)]
    candidate = days[0]
    while len(days) < count:
        candidate += timedelta(days=1)
        if is_trading_day(candidate):
            days.append(candidate)
    return days


def trading_day_options(
    broker: str | None,
    count: int = 4,
    *,
    from_dt: datetime | None = None,
) -> dict[str, Any]:
    config = market_open_config(broker)
    options: list[dict[str, str]] = []
    for index, day in enumerate(upcoming_trading_days(broker, count, from_dt=from_dt)):
        start_at = scheduled_start_at(broker, day)
        label = "Next session" if index == 0 else day.strftime("%a %d %b")
        options.append(
            {
                "trading_day": day.isoformat(),
                "label": label,
                "scheduled_start_at": start_at.isoformat(),
            }
        )
    return {
        "broker": normalize_broker(broker),
        "market_open_label": config["label"],
        "timezone": str(config["tz"]),
        "options": options,
    }


def default_schedule(broker: str | None, *, from_dt: datetime | None = None) -> dict[str, str]:
    options = trading_day_options(broker, count=1, from_dt=from_dt)
    first = options["options"][0]
    return {
        "broker": options["broker"],
        "trading_day": first["trading_day"],
        "scheduled_start_at": first["scheduled_start_at"],
        "market_open_label": options["market_open_label"],
        "timezone": options["timezone"],
    }


def parse_trading_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        return None


def resolve_schedule(
    broker: str | None,
    *,
    schedule_enabled: bool = False,
    scheduled_date: str | None = None,
    start_immediately: bool = False,
    from_dt: datetime | None = None,
) -> dict[str, Any] | None:
    if start_immediately or not schedule_enabled:
        return None

    trading_day = parse_trading_day(scheduled_date)
    if trading_day is None:
        raise ValueError("scheduled_date is required when scheduling is enabled")

    start_at = scheduled_start_at(broker, trading_day)
    config = market_open_config(broker)
    return {
        "trading_day": trading_day.isoformat(),
        "scheduled_start_at": start_at.isoformat(),
        "market_open_label": config["label"],
        "timezone": str(config["tz"]),
    }
