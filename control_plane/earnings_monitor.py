from __future__ import annotations

from datetime import date, timedelta
from typing import Any


def parse_earnings_date(value: str | None) -> date | None:
    if not value:
        return None
    raw = str(value).split("T", 1)[0].split(" ", 1)[0].strip()
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def build_earnings_monitors(
    events: list[dict[str, Any]],
    *,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """Build sticky monitor alerts for earnings today and the day after."""
    today = today or date.today()
    yesterday = today - timedelta(days=1)
    monitors: list[dict[str, Any]] = []
    seen: set[str] = set()

    for event in events:
        event_date = parse_earnings_date(event.get("date"))
        if not event_date:
            continue
        symbol = str(event.get("symbol") or event.get("finnhubSymbol") or "").upper()
        if not symbol:
            continue

        phase: str | None = None
        if event_date == yesterday:
            phase = "post_earnings"
        elif event_date == today:
            phase = "earnings_today"

        if not phase:
            continue

        dedupe_key = f"{symbol}:{event_date.isoformat()}:{phase}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        hour = str(event.get("hour") or "").lower()
        when = {"bmo": "before open", "amc": "after close", "dmh": "during session"}.get(hour, hour or "tbd")
        message = (
            f"{symbol} reported earnings yesterday — watch for post-call drift today."
            if phase == "post_earnings"
            else f"{symbol} reports earnings today ({when})."
        )

        monitors.append(
            {
                "id": dedupe_key,
                "symbol": symbol,
                "phase": phase,
                "earningsDate": event_date.isoformat(),
                "quarter": event.get("quarter"),
                "year": event.get("year"),
                "hour": event.get("hour"),
                "watchlistRefs": event.get("watchlistRefs") or [],
                "message": message,
            }
        )

    phase_order = {"post_earnings": 0, "earnings_today": 1}
    monitors.sort(key=lambda row: (phase_order.get(str(row.get("phase")), 9), str(row.get("symbol"))))
    return monitors
