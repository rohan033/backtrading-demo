"""Dynamic profit exits from websocket samples — 30s uptrend break detection."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def profit_window_seconds(config: dict[str, Any]) -> float:
    if config.get("profit_window_seconds") is not None:
        return max(5.0, float(config["profit_window_seconds"]))
    return 30.0


def profit_check_seconds(config: dict[str, Any]) -> float:
    if config.get("profit_check_seconds") is not None:
        return max(5.0, float(config["profit_check_seconds"]))
    return profit_window_seconds(config)


def _empty_plan(position: dict[str, Any], *, window_seconds: float) -> dict[str, Any]:
    return {
        "position_id": position["id"],
        "ticker": position["ticker"],
        "recent_high": None,
        "recent_low": None,
        "peak_price": None,
        "window_seconds": window_seconds,
        "window_minutes": round(window_seconds / 60.0, 3),
        "sample_count": 0,
        "profit_lock": None,
        "levels": [],
        "levels_hit": [],
        "next_level": None,
        "momentum": "flat",
        "uptrend_intact": True,
        "should_secure": False,
        "rebuy_candidate": False,
        "active": False,
        "gain_pct": 0.0,
        "peak_gain_pct": 0.0,
        "price_source": "websocket",
        "updated_at": _now(),
    }


def _uptrend_intact(
    *,
    closes: list[float],
    price: float,
    recent_high: float,
    peak_price: float,
    config: dict[str, Any],
) -> bool:
    """True while price is still pushing highs — hold for more profit."""
    tolerance = float(config.get("profit_uptrend_tolerance_pct", 0.15)) / 100.0

    if price >= peak_price * (1 - tolerance):
        return True
    if price >= recent_high * (1 - tolerance):
        return True

    if len(closes) >= 3:
        tail = closes[-3:]
        if all(tail[index] > tail[index - 1] for index in range(1, len(tail))):
            return True

    if len(closes) >= 2 and closes[-1] >= max(closes[:-1]):
        return True

    return False


def compute_exit_plan(
    position: dict[str, Any],
    *,
    window_stats: dict[str, Any],
    config: dict[str, Any],
    prior: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ratchet session peak profit; secure only when the 30s uptrend breaks."""
    buy = float(position.get("buy_price") or 0.0)
    price = float(position.get("current_price") or buy or 0.0)
    window_seconds = profit_window_seconds(config)
    if buy <= 0 or price <= 0:
        return prior or _empty_plan(position, window_seconds=window_seconds)

    recent_high = window_stats.get("recent_high")
    recent_low = window_stats.get("recent_low")
    closes = list(window_stats.get("closes") or [])
    sample_count = int(window_stats.get("sample_count") or 0)

    if recent_high is None or recent_low is None:
        plan = prior or _empty_plan(position, window_seconds=window_seconds)
        plan["updated_at"] = _now()
        plan["sample_count"] = sample_count
        return plan

    recent_high = float(recent_high)
    recent_low = float(recent_low)
    prior_peak = float((prior or {}).get("peak_price") or buy)
    peak_price = max(prior_peak, recent_high, price)
    peak_gain = peak_price - buy
    trail_pct = float(config.get("profit_trail_pct", 0.25)) / 100.0
    lock_fraction = float(config.get("profit_lock_fraction", 0.35))

    uptrend_intact = _uptrend_intact(
        closes=closes,
        price=price,
        recent_high=recent_high,
        peak_price=peak_price,
        config=config,
    )

    momentum = "flat"
    rebuy_samples = max(2, int(config.get("profit_rebuy_momentum_closes", 3)))
    if len(closes) >= rebuy_samples:
        tail = closes[-rebuy_samples:]
        if all(tail[index] > tail[index - 1] for index in range(1, len(tail))):
            momentum = "rising"
        elif all(tail[index] < tail[index - 1] for index in range(1, len(tail))):
            momentum = "falling"

    prior_lock = float((prior or {}).get("profit_lock") or 0.0)
    trail_lock = peak_price * (1 - trail_pct)
    gain_lock = buy + peak_gain * lock_fraction
    profit_lock = max(prior_lock, trail_lock, gain_lock, buy * 1.001)

    peak_gain_pct = peak_gain / buy * 100.0 if buy > 0 else 0.0
    min_move_display_pct = float(config.get("profit_min_move_pct", 0.35))
    in_profit_zone = peak_gain_pct >= min_move_display_pct
    should_secure = bool(
        in_profit_zone and not uptrend_intact and price <= profit_lock
    )

    plan = _empty_plan(position, window_seconds=window_seconds)
    plan.update(
        {
            "recent_high": round(recent_high, 6),
            "recent_low": round(recent_low, 6),
            "peak_price": round(peak_price, 6),
            "sample_count": sample_count,
            "momentum": momentum,
            "uptrend_intact": uptrend_intact,
            "should_secure": should_secure,
            "gain_pct": round((recent_high - buy) / buy * 100.0, 3) if buy > 0 else 0.0,
            "peak_gain_pct": round(peak_gain_pct, 3),
            "profit_lock": round(profit_lock, 6) if in_profit_zone else None,
            "active": in_profit_zone,
            "rebuy_candidate": momentum == "rising",
            "updated_at": _now(),
        }
    )

    level_fracs = config.get("profit_level_fractions") or [0.35, 0.60, 0.85]
    trim_fraction = float(config.get("profit_trim_fraction", 0.25))
    levels: list[dict[str, Any]] = []
    for index, fraction in enumerate(level_fracs, start=1):
        level_id = f"L{index}"
        target = buy + peak_gain * float(fraction)
        levels.append(
            {
                "id": level_id,
                "price": round(target, 6),
                "fraction": trim_fraction,
                "label": f"{int(float(fraction) * 100)}% of peak gain",
                "hit": False,
            }
        )
    plan["levels"] = levels
    plan["next_level"] = levels[0] if levels and in_profit_zone else None
    return plan


def scan_rebuy_watchlist(
    ticker: str,
    *,
    window_stats: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any] | None:
    """Momentum scan for watchlist names not currently held."""
    window_seconds = profit_window_seconds(config)
    closes = list(window_stats.get("closes") or [])
    if len(closes) < 3:
        return None

    rebuy_samples = max(2, int(config.get("profit_rebuy_momentum_closes", 3)))
    tail = closes[-rebuy_samples:]
    rising = all(tail[index] > tail[index - 1] for index in range(1, len(tail)))
    if not rising:
        return None

    recent_high = window_stats.get("recent_high")
    if recent_high is None:
        return None
    recent_high = float(recent_high)
    base = float(closes[0])
    move_pct = (recent_high - base) / base * 100.0 if base > 0 else 0.0
    min_move = float(config.get("profit_rebuy_min_move_pct", 0.5))
    if move_pct < min_move:
        return None

    return {
        "ticker": ticker.upper(),
        "recent_high": round(recent_high, 6),
        "move_pct": round(move_pct, 3),
        "momentum": "rising",
        "window_seconds": window_seconds,
        "window_minutes": round(window_seconds / 60.0, 3),
    }
