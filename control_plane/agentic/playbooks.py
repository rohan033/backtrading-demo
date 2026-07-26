"""Trade playbooks and deterministic rotation-edge calculations."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_playbook(
    position: dict[str, Any],
    suggestion: dict[str, Any],
    *,
    atr: float | None,
) -> dict[str, Any]:
    price = float(position.get("buy_price") or 0)
    stop = float(position.get("stop_loss") or 0)
    return {
        "position_id": position["id"],
        "ticker": position["ticker"],
        "created_at": _now(),
        "reviewed_at": _now(),
        "entry_thesis": suggestion.get("reason") or "High-confidence momentum candidate",
        "bullish_hold_conditions": [
            "Price remains above the effective trailing stop",
            "Five-minute structure continues making stable or higher lows",
        ],
        "warning_signs": [
            "Closed candle undercuts the prior candle low",
            "Critical filing, offering, dilution, or company news",
        ],
        "hard_exit_conditions": [
            f"Price at or below {stop:.4f}",
            "Daily-loss or exposure circuit breaker",
            "Broker margin/risk circuit breaker",
        ],
        "entry_price": price,
        "hard_stop": stop,
        "atr_at_entry": atr,
        "candidate_score": float(suggestion.get("score") or 0),
        "state": "active",
    }


def review_playbook(playbook: dict[str, Any], position: dict[str, Any]) -> dict[str, Any]:
    reviewed = dict(playbook)
    price = float(position.get("current_price") or position.get("buy_price") or 0)
    stop = float(position.get("stop_loss") or playbook.get("hard_stop") or 0)
    reviewed["reviewed_at"] = _now()
    reviewed["last_price"] = price
    reviewed["distance_to_hard_stop_pct"] = (
        round((price - stop) / price * 100, 3) if price > 0 else None
    )
    reviewed["state"] = "warning" if position.get("exit_state") == "weakening" else "active"
    return reviewed


def rotation_edge(
    *,
    candidate_score: float,
    holding_score: float,
    slippage_bps: float,
    edge_margin_pct: float,
) -> dict[str, Any]:
    candidate_edge_pct = candidate_score / 10.0
    holding_edge_pct = holding_score / 10.0
    transaction_cost_pct = max(0.0, slippage_bps) * 2.0 / 100.0
    net_advantage = candidate_edge_pct - holding_edge_pct - transaction_cost_pct
    return {
        "candidate_edge_pct": round(candidate_edge_pct, 3),
        "holding_edge_pct": round(holding_edge_pct, 3),
        "estimated_round_trip_cost_pct": round(transaction_cost_pct, 3),
        "net_advantage_pct": round(net_advantage, 3),
        "required_margin_pct": edge_margin_pct,
        "rotate": net_advantage >= edge_margin_pct,
    }
