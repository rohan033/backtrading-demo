"""Dynamic profit exits from websocket samples — 30s uptrend break detection.

Exit layers per position (evaluated in this order each monitor tick):
1. Secure-exit: uptrend broken AND price <= profit lock -> full close.
2. Pullback ladder: rung targets are fractions of peak gain; a rung fires
   when price *pulls back* to it (never on the way up — during a climb the
   price IS the peak, so every target sits at/below price by construction).
   Each hit trims a slice of the ORIGINAL position size and ratchets the stop.
3. Stall detector: no new high for `profit_peak_stale_seconds` while near
   peak -> one-time trim (covers "stuck near peak inside the uptrend
   tolerance band" where neither of the above fires).
"""

from __future__ import annotations

import time
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
        # Trim ledger: fraction of ORIGINAL entry size still held. Ladder and
        # stall trims are budgeted against this so they can never oversell.
        # Re-derived each monitor tick from units/entry_units, so external
        # trims (candle-machine weakening trim, manual trims) count too.
        "remaining_fraction": 1.0,
        "entry_units": None,
        "last_hit_price": None,
        # Stall detector state
        "last_new_high_at": None,
        "stall_handled": False,
        "stalled": False,
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

    prior_peak_recorded = float((prior or {}).get("peak_price") or 0.0)
    made_new_high = peak_price > prior_peak_recorded + 1e-9

    # Stall state: a fresh high resets the clock and re-arms the guard.
    now_epoch = time.time()
    prior_last_high = (prior or {}).get("last_new_high_at")
    prior_stall_handled = bool((prior or {}).get("stall_handled"))
    if made_new_high or prior_last_high is None:
        last_new_high_at: float | None = now_epoch
        stall_handled = False
    else:
        last_new_high_at = float(prior_last_high)
        stall_handled = prior_stall_handled

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
            "remaining_fraction": float((prior or {}).get("remaining_fraction", 1.0)),
            "entry_units": (prior or {}).get("entry_units"),
            "last_hit_price": (prior or {}).get("last_hit_price"),
            "last_new_high_at": last_new_high_at,
            "stall_handled": stall_handled,
            "stalled": bool((prior or {}).get("stalled")) and not made_new_high,
            "updated_at": _now(),
        }
    )

    # Ladder rungs: carry hit state across ticks; only un-hit rungs re-target
    # off the live (ratcheting) peak gain. Hit rungs stay frozen for the UI.
    prior_levels = {
        str(level.get("id")): level
        for level in ((prior or {}).get("levels") or [])
        if isinstance(level, dict)
    }
    level_fracs = config.get("profit_level_fractions") or [0.35, 0.60, 0.85]
    trim_fraction = float(config.get("profit_trim_fraction", 0.25))
    levels: list[dict[str, Any]] = []
    for index, fraction in enumerate(level_fracs, start=1):
        level_id = f"L{index}"
        prior_level = prior_levels.get(level_id)
        if prior_level and prior_level.get("hit"):
            levels.append(dict(prior_level))
            continue
        target = buy + peak_gain * float(fraction)
        levels.append(
            {
                "id": level_id,
                "gain_fraction": float(fraction),
                "price": round(target, 6),
                "fraction": trim_fraction,
                "label": f"{int(float(fraction) * 100)}% of peak gain",
                "hit": False,
                "hit_price": None,
                "hit_at": None,
            }
        )
    plan["levels"] = levels
    plan["levels_hit"] = sorted(
        level["id"] for level in levels if level.get("hit")
    )
    # Next rung to fire on a pullback = highest un-hit target below the peak.
    unhit = [level for level in levels if not level.get("hit")]
    plan["next_level"] = (
        max(unhit, key=lambda level: float(level.get("price") or 0.0))
        if unhit and in_profit_zone
        else None
    )
    return plan


def evaluate_ladder(
    plan: dict[str, Any],
    *,
    buy_price: float,
    price: float,
) -> list[dict[str, Any]]:
    """Rungs fire on PULLBACK: price <= target. Highest rung first, since a
    sharp drop can cross several rungs in one tick. Mutates plan levels."""
    if not plan.get("active"):
        return []
    peak_price = float(plan.get("peak_price") or 0.0)
    peak_gain = peak_price - buy_price
    if peak_gain <= 0 or price <= 0:
        return []

    triggered: list[dict[str, Any]] = []
    levels = [level for level in (plan.get("levels") or []) if isinstance(level, dict)]
    for level in sorted(
        levels, key=lambda row: -float(row.get("gain_fraction") or 0.0)
    ):
        if level.get("hit"):
            continue
        gain_fraction = float(level.get("gain_fraction") or 0.0)
        target = buy_price + gain_fraction * peak_gain
        level["price"] = round(target, 6)
        if price <= target:
            level["hit"] = True
            level["hit_price"] = round(price, 6)
            level["hit_at"] = _now()
            triggered.append(level)

    if triggered:
        plan["levels_hit"] = sorted(
            level["id"] for level in levels if level.get("hit")
        )
        unhit = [level for level in levels if not level.get("hit")]
        plan["next_level"] = (
            max(unhit, key=lambda row: float(row.get("price") or 0.0))
            if unhit
            else None
        )
    return triggered


def evaluate_stall(
    plan: dict[str, Any],
    *,
    config: dict[str, Any],
    now_epoch: float | None = None,
) -> bool:
    """One-shot per stall episode: no new high for `profit_peak_stale_seconds`
    while the plan is armed. compute_exit_plan resets the clock on new highs."""
    if not plan.get("active") or plan.get("stall_handled"):
        return False
    last_high = plan.get("last_new_high_at")
    if last_high is None:
        return False
    now = now_epoch if now_epoch is not None else time.time()
    stale_seconds = float(config.get("profit_peak_stale_seconds", 90.0))
    if now - float(last_high) < stale_seconds:
        return False
    plan["stall_handled"] = True
    plan["stalled"] = True
    return True


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
