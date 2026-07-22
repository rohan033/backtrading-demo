from control_plane.one_percent_candidates import compute_attempt_brackets
from control_plane.one_percent_session_engine import _threshold_hit
from control_plane.one_percent_session_store import normalize_config


def test_compute_attempt_brackets_uses_fixed_stock_tp_pct():
    brackets = compute_attempt_brackets(
        entry_price=100.0,
        capital=1000.0,
        take_profit_pct=1.5,
        stop_loss_pct=2.0,
        cumulative_pnl=-50.0,
        target_dollars=10.0,
    )
    # Remaining session target must NOT inflate per-stock TP.
    assert brackets["take_profit_pct"] == 1.5
    assert brackets["take_profit_price"] == 101.5
    assert brackets["stop_loss_pct"] == 2.0
    assert brackets["stop_loss_price"] == 98.0
    assert brackets["remaining_target"] == 60.0


def test_tiny_tp_does_not_soft_hit_at_entry_mark():
    """Regression: 0.1% TP + tp*0.999 used to equal entry and force-close on fill."""
    entry = 1803.85
    tp = round(entry * 1.001, 2)  # 1804.85
    mark = 1803.05  # still red vs entry
    assert _threshold_hit(
        current=mark,
        entry_price=entry,
        pnl_amount=-0.44,
        take_profit_price=tp,
        stop_loss_price=round(entry * 0.98, 2),
        take_profit_pct=0.1,
        stop_loss_pct=2.0,
        pnl_pct=-0.044,
    ) is None


def test_threshold_hit_near_configured_tp_soft_band():
    entry = 100.0
    tp = 101.5  # 1.5% — soft is tp*0.999 ≈ 101.40
    assert _threshold_hit(
        current=101.40,
        entry_price=entry,
        pnl_amount=1.4,
        take_profit_price=tp,
        stop_loss_price=98.0,
        take_profit_pct=1.5,
        stop_loss_pct=2.0,
        pnl_pct=1.4,
    ) == "take_profit"


def test_normalize_config_floors_tiny_take_profit_pct():
    cfg = normalize_config({"take_profit_pct": 0.1, "capital": 1000})
    assert cfg["take_profit_pct"] >= 0.5
