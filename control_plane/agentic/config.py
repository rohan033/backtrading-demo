"""Single source of truth for agentic session config defaults.

Per-session overrides come from the create-session `config` payload merged
over these defaults; a free-text session `prompt` can additionally derive a
small set of SAFE overrides (never `dry_run` — real-order mode must be an
explicit config flag, not something inferred from prose).
"""

from __future__ import annotations

import re
from typing import Any

# IMPORTANT: dry_run defaults to FALSE. Demo account_env already routes to eToro's
# demo/paper API — use dry_run=True only to simulate fills locally without any
# broker call (debug / offline).
DEFAULT_CONFIG: dict[str, Any] = {
    # Order execution
    "dry_run": False,
    # Market hunter / session scope (empty lists = no filter / backward compatible)
    "screener_ids": [],                    # non-empty => only these screener result sets
    "tickers": [],                         # manual watchlist tickers (e.g. BTC) always evaluated
    # Market hunter
    "hunter_interval_seconds": 60.0,       # scan cadence
    "hunter_thinking_cooldown_seconds": 600.0,  # min gap between hunter LLM narrations
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
    # Portfolio monitor — dynamic profit from websocket samples (30s uptrend check)
    "profit_window_seconds": 30.0,         # rolling high/low window (websocket ticks)
    "profit_check_seconds": 30.0,          # portfolio monitor evaluation cadence
    "profit_min_move_pct": 0.35,           # need this % above entry before secure logic arms
    "profit_trail_pct": 0.25,              # pullback from peak that triggers secure on break
    "profit_uptrend_tolerance_pct": 0.15,  # still "at peak" within this % of session high
    "profit_lock_fraction": 0.35,          # ratcheting floor: lock this share of peak gain
    "profit_level_fractions": [0.35, 0.60, 0.85],  # display targets along peak gain
    "profit_trim_fraction": 0.25,
    "profit_rebuy_momentum_closes": 3,
    "profit_rebuy_min_move_pct": 0.5,
    "position_monitor_seconds": 30.0,
    "playbook_review_seconds": 300.0,
    "strategy_review_seconds": 300.0,
    "news_monitor_seconds": 300.0,
    "news_filings_seconds": 1800.0,
    "risk_monitor_seconds": 30.0,
    # Rotation
    "rotation_margin": 15.0,               # B.score must beat A.momentum + margin
    "rotation_slippage_bps": 15.0,
    "rotation_edge_margin_pct": 1.0,
    # Autonomous stop (circuit breaker)
    "max_drawdown_pct": 10.0,              # realized-PnL drawdown % of start_balance
    "max_daily_loss_pct": 5.0,
    "max_exposure_pct": 80.0,
    "max_consecutive_losses": 4,
    # Idempotency / flapping
    "action_debounce_seconds": 5.0,
    "event_dedupe_seconds": 120.0,
    "orchestrator_cooldown_seconds": 10.0,
    "orchestrator_wakeups_per_hour": 30,
    "fast_reasoning_timeout_seconds": 2.0,
    "strategic_reasoning_timeout_seconds": 25.0,
    "event_queue_size": 200,
    # Reconciliation
    "reconcile_interval_seconds": 45.0,
    "reconcile_close_retries": 3,
    # Cursor agent model for orchestrator + sub-agents (None = SDK default)
    "agent_model": None,
    "agent_model_params": [],
}

DEFAULT_START_BALANCE = 1000.0

_NUMERIC_KEYS = {
    key for key, value in DEFAULT_CONFIG.items() if isinstance(value, (int, float)) and not isinstance(value, bool)
}
_BOOL_KEYS = {key for key, value in DEFAULT_CONFIG.items() if isinstance(value, bool)}
_LIST_KEYS = {"screener_ids", "tickers", "profit_level_fractions"}
_AGENT_MODEL_KEYS = frozenset({"agent_model", "agent_model_params"})


def _normalize_agent_model(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _normalize_agent_model_params(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return list(DEFAULT_CONFIG["agent_model_params"])
    out: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        param_id = str(item.get("id") or "").strip()
        param_value = str(item.get("value") or "").strip()
        if param_id and param_value:
            out.append({"id": param_id, "value": param_value})
    return out


def _normalize_list_value(key: str, value: Any) -> list[str]:
    if not isinstance(value, list):
        return list(DEFAULT_CONFIG[key])
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        out.append(text.upper() if key == "tickers" else text)
    return out

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
        if key in _LIST_KEYS:
            merged[key] = _normalize_list_value(key, value)
            continue
        if key == "agent_model":
            merged[key] = _normalize_agent_model(value)
            continue
        if key == "agent_model_params":
            merged[key] = _normalize_agent_model_params(value)
            continue
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


def patch_config(existing: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Apply a partial config patch onto an existing session config."""
    return merge_config({**existing, **patch})
