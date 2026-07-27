"""Shared dynamic profit-ladder builder (Positions tab + agentic monitor).

Base rungs default to 35% / 60% / 85% of peak gain with 25% spacing. The ladder
extends through 100% (peak) and adds new rungs when price keeps rising after
earlier trims were taken.
"""

from __future__ import annotations

import json
from typing import Any

LADDER_FRACTIONS = (0.35, 0.60, 0.85)
DEFAULT_STEP = 0.25
MAX_FRACTION = 1.0
PRICE_EPSILON = 1e-6


def infer_ladder_step(fractions: list[float]) -> float:
    if len(fractions) >= 2:
        step = float(fractions[-1]) - float(fractions[-2])
        if step > 0:
            return step
    return DEFAULT_STEP


def extended_gain_fractions(gain_fractions: list[float] | None) -> list[float]:
    """Configured base rungs, then the same step through 100% of peak gain."""
    base = [float(x) for x in (gain_fractions or LADDER_FRACTIONS)]
    if len(base) < 3:
        defaults = list(LADDER_FRACTIONS)
        while len(base) < 3:
            base.append(defaults[len(base)])
    step = infer_ladder_step(base)
    out = list(base[:3])
    while out[-1] < MAX_FRACTION - 1e-9:
        nxt = round(out[-1] + step, 6)
        if nxt >= MAX_FRACTION:
            out.append(MAX_FRACTION)
            break
        out.append(nxt)
    return out


def _load_prior_levels(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    prior: dict[str, dict[str, Any]] = {}
    raw = state.get("levels_json") if "levels_json" in state else state.get("levels")
    parsed: Any = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = []
    if isinstance(parsed, list):
        for row in parsed:
            if isinstance(row, dict) and row.get("id"):
                prior[str(row["id"])] = dict(row)
    for index, key in enumerate(("l1_hit", "l2_hit", "l3_hit"), start=1):
        if state.get(key):
            level_id = f"L{index}"
            if level_id not in prior:
                prior[level_id] = {"id": level_id, "hit": True}
            else:
                prior[level_id]["hit"] = True
    return prior


def _level_price(buy: float, peak_gain: float, fraction: float, *, is_buy: bool) -> float:
    if is_buy:
        return buy + peak_gain * fraction
    return buy - peak_gain * fraction


def _make_level(
    level_id: str,
    fraction: float,
    price: float,
    trim: float,
    *,
    hit: bool = False,
    hit_price: float | None = None,
    hit_at: str | None = None,
) -> dict[str, Any]:
    pct = int(round(fraction * 100))
    return {
        "id": level_id,
        "gain_fraction": float(fraction),
        "price": round(price, 6),
        "fraction": trim,
        "label": f"{pct}% of peak gain",
        "hit": hit,
        "hit_price": hit_price,
        "hit_at": hit_at,
    }


def _append_rungs_for_new_peak(
    levels: list[dict[str, Any]],
    *,
    buy: float,
    peak: float,
    peak_gain: float,
    is_buy: bool,
    trim: float,
    step: float,
) -> None:
    """When every rung is hit but price made a new high, add rungs toward the peak."""
    if not levels or any(not level.get("hit") for level in levels):
        return
    max_hit_price = max(float(level["price"]) for level in levels)
    if peak <= max_hit_price + peak_gain * 0.001:
        return

    next_index = len(levels) + 1
    last_frac = max(float(level.get("gain_fraction") or 0) for level in levels)
    frac = last_frac + step
    while True:
        eff = min(frac, MAX_FRACTION)
        price = _level_price(buy, peak_gain, eff, is_buy=is_buy)
        if price > max_hit_price + peak_gain * 0.001:
            levels.append(
                _make_level(f"L{next_index}", eff, price, trim),
            )
            next_index += 1
            max_hit_price = price
        if eff >= MAX_FRACTION - 1e-9 or abs(price - peak) <= peak_gain * 0.001:
            break
        frac += step

    if peak > max_hit_price + peak_gain * 0.001:
        levels.append(
            _make_level(f"L{next_index}", MAX_FRACTION, peak, trim),
        )


def build_ladder_levels(
    state: dict[str, Any],
    buy: float,
    peak: float,
    *,
    gain_fractions: list[float] | None = None,
    trim_fraction: float = 0.25,
    is_buy: bool | None = None,
) -> list[dict[str, Any]]:
    if buy <= 0 or peak <= 0:
        return []
    is_buy_val = bool(state.get("is_buy", True)) if is_buy is None else is_buy
    peak_gain = peak - buy if is_buy_val else buy - peak
    if peak_gain <= PRICE_EPSILON:
        return []

    fractions_source = gain_fractions if gain_fractions is not None else state.get("gain_fractions")
    fractions = extended_gain_fractions(
        list(fractions_source) if fractions_source else None
    )
    trim = float(trim_fraction)
    prior = _load_prior_levels(state)
    step = infer_ladder_step(fractions)

    levels: list[dict[str, Any]] = []
    for index, fraction in enumerate(fractions, start=1):
        level_id = f"L{index}"
        prior_level = prior.get(level_id)
        if prior_level and prior_level.get("hit"):
            levels.append(dict(prior_level))
            continue
        price = _level_price(buy, peak_gain, fraction, is_buy=is_buy_val)
        levels.append(
            _make_level(
                level_id,
                fraction,
                price,
                trim,
                hit=bool(prior_level.get("hit")) if prior_level else False,
                hit_price=prior_level.get("hit_price") if prior_level else None,
                hit_at=prior_level.get("hit_at") if prior_level else None,
            )
        )

    _append_rungs_for_new_peak(
        levels,
        buy=buy,
        peak=peak,
        peak_gain=peak_gain,
        is_buy=is_buy_val,
        trim=trim,
        step=step,
    )
    return levels
