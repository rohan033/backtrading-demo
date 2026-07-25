"""Single source of truth for agentic session config defaults.

Per-session overrides come from the create-session `config` payload merged
over these defaults; a free-text session `prompt` can additionally derive a
small set of SAFE overrides (never `dry_run` — real-order mode must be an
explicit config flag, not something inferred from prose).
"""

from __future__ import annotations

import re
from typing import Any

# IMPORTANT: dry_run defaults to TRUE. In dry-run the engine simulates fills
# at the current market price and logs/persists everything identically to a
# real session, but never calls the broker execution API.
DEFAULT_CONFIG: dict[str, Any] = {
    # Order execution
    "dry_run": True,
    # Market hunter
    "hunter_interval_seconds": 60.0,       # scan cadence
    "min_suggestion_score": 40.0,          # global hunter floor
    "suggestion_cooldown_seconds": 600.0,  # don't re-emit a ticker within 10 min
    # Entry pipeline
    "confidence_threshold": 60.0,          # session consumes suggestions >= this
    "per_position_cap_pct": 20.0,          # max % of start_balance per position
    "total_exposure_cap_pct": 80.0,        # max % of start_balance deployed
    "min_allocation_usd": 20.0,            # below this headroom => fully allocated
    # Stops / exit state machine (5-minute candles)
    "atr_period": 14,
    "stop_loss_atr_multiple": 2.0,         # hard stop at entry - 2*ATR(14)
    "stop_loss_fallback_pct": 5.0,         # fallback: 5% below entry
    "trail_atr_multiple_running": 3.0,     # Running: trail 3x ATR off peak
    "trail_atr_multiple_weakening": 1.0,   # Weakening: tighten to 1x ATR
    "weakening_trim_fraction": 0.5,        # trim 50% on Running -> Weakening
    "exit_poll_seconds": 30.0,             # candle/halt poll cadence
    # Rotation
    "rotation_margin": 15.0,               # B.score must beat A.momentum + margin
    # Autonomous stop (circuit breaker)
    "max_drawdown_pct": 10.0,              # realized-PnL drawdown % of start_balance
    "max_consecutive_losses": 4,
    # Idempotency / flapping
    "action_debounce_seconds": 5.0,
    # Reconciliation
    "reconcile_interval_seconds": 45.0,
    "reconcile_close_retries": 3,
}

DEFAULT_START_BALANCE = 1000.0

_NUMERIC_KEYS = {
    key for key, value in DEFAULT_CONFIG.items() if isinstance(value, (int, float)) and not isinstance(value, bool)
}
_BOOL_KEYS = {key for key, value in DEFAULT_CONFIG.items() if isinstance(value, bool)}

# Prompt-derived overrides: only low-risk tuning knobs. `dry_run` is
# intentionally NOT derivable from the prompt.
_PROMPT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("confidence_threshold", re.compile(r"confidence(?:\s*threshold)?\s*(?:of|at|to|[:=])?\s*(\d{1,3})", re.I)),
    ("max_drawdown_pct", re.compile(r"(?:max\s*)?drawdown\s*(?:of|at|to|[:=])?\s*(\d{1,2}(?:\.\d+)?)\s*%", re.I)),
    ("per_position_cap_pct", re.compile(r"(?:per[-\s]?position|position\s*cap)\s*(?:of|at|to|[:=])?\s*(\d{1,2}(?:\.\d+)?)\s*%", re.I)),
    ("total_exposure_cap_pct", re.compile(r"(?:total\s*)?exposure\s*(?:cap)?\s*(?:of|at|to|[:=])?\s*(\d{1,3}(?:\.\d+)?)\s*%", re.I)),
    ("max_consecutive_losses", re.compile(r"(\d)\s*consecutive\s*(?:losing|loss)", re.I)),
]

_PROMPT_BOUNDS: dict[str, tuple[float, float]] = {
    "confidence_threshold": (0.0, 100.0),
    "max_drawdown_pct": (1.0, 50.0),
    "per_position_cap_pct": (1.0, 100.0),
    "total_exposure_cap_pct": (5.0, 100.0),
    "max_consecutive_losses": (1.0, 20.0),
}


def config_overrides_from_prompt(prompt: str | None) -> dict[str, Any]:
    """Extract safe numeric overrides from a free-text session prompt."""
    text = (prompt or "").strip()
    if not text:
        return {}
    overrides: dict[str, Any] = {}
    for key, pattern in _PROMPT_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            value = float(match.group(1))
        except ValueError:
            continue
        lo, hi = _PROMPT_BOUNDS[key]
        if lo <= value <= hi:
            overrides[key] = int(value) if isinstance(DEFAULT_CONFIG[key], int) else value
    return overrides


def merge_config(
    overrides: dict[str, Any] | None = None,
    *,
    prompt: str | None = None,
) -> dict[str, Any]:
    """defaults <- prompt-derived <- explicit overrides (explicit wins)."""
    merged = dict(DEFAULT_CONFIG)
    merged.update(config_overrides_from_prompt(prompt))
    for key, value in (overrides or {}).items():
        if key not in DEFAULT_CONFIG:
            continue
        if key in _BOOL_KEYS:
            merged[key] = bool(value)
        elif key in _NUMERIC_KEYS:
            try:
                default = DEFAULT_CONFIG[key]
                merged[key] = int(value) if isinstance(default, int) else float(value)
            except (TypeError, ValueError):
                continue
        else:
            merged[key] = value
    return merged
