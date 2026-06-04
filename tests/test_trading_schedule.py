from datetime import date, datetime, timezone

import pytest

from control_plane.trading_schedule import (
    default_schedule,
    next_trading_day,
    resolve_schedule,
    scheduled_start_at,
)


def test_next_trading_day_before_open_uses_same_day():
    # Monday 08:00 IST -> same Monday
    monday_morning_ist = datetime(2026, 5, 25, 2, 30, tzinfo=timezone.utc)
    assert next_trading_day("angel", from_dt=monday_morning_ist) == date(2026, 5, 25)


def test_next_trading_day_after_open_uses_next_weekday():
    # Monday 10:00 IST -> Tuesday
    monday_after_open_ist = datetime(2026, 5, 25, 5, 0, tzinfo=timezone.utc)
    assert next_trading_day("angel", from_dt=monday_after_open_ist) == date(2026, 5, 26)


def test_next_trading_day_skips_weekend_from_friday_after_close():
    # Friday 12:00 IST -> Monday
    friday_noon_ist = datetime(2026, 5, 22, 6, 30, tzinfo=timezone.utc)
    assert next_trading_day("angel", from_dt=friday_noon_ist) == date(2026, 5, 25)


def test_scheduled_start_at_angel_uses_ist_915():
    start = scheduled_start_at("angel", date(2026, 5, 25))
    assert start.hour == 3
    assert start.minute == 45
    assert start.tzinfo == timezone.utc


def test_scheduled_start_at_etoro_uses_cest_330_pm():
    start = scheduled_start_at("etoro", date(2026, 5, 25))
    assert start.hour == 13
    assert start.minute == 30
    assert start.tzinfo == timezone.utc


def test_default_schedule_includes_market_open_label():
    data = default_schedule(
        "angel",
        from_dt=datetime(2026, 5, 25, 2, 30, tzinfo=timezone.utc),
    )
    assert data["trading_day"] == "2026-05-25"
    assert data["market_open_label"] == "IST 09:15"
    assert data["scheduled_start_at"].endswith("+00:00")


def test_resolve_schedule_disabled_returns_none():
    assert resolve_schedule("angel", schedule_enabled=False) is None


def test_resolve_schedule_immediate_returns_none():
    assert resolve_schedule("angel", schedule_enabled=True, start_immediately=True) is None


def test_resolve_schedule_requires_date_when_enabled():
    with pytest.raises(ValueError, match="scheduled_date is required"):
        resolve_schedule("etoro", schedule_enabled=True)


def test_resolve_schedule_with_explicit_date():
    schedule = resolve_schedule(
        "etoro",
        schedule_enabled=True,
        scheduled_date="2026-05-25",
    )
    assert schedule is not None
    assert schedule["trading_day"] == "2026-05-25"
    assert schedule["market_open_label"] == "CEST 3:30 PM"


def test_resolve_schedule_rejects_weekend():
    with pytest.raises(ValueError):
        scheduled_start_at("angel", date(2026, 5, 24))
