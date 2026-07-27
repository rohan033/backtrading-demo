import pytest

from brokers.etoro.order_helpers import (
    DEFAULT_BRACKET_STOP_LOSS_AMOUNT,
    apply_v1_bracket_fields,
    apply_v2_bracket_fields,
    classify_order_poll_outcome,
    compute_stop_loss_price,
    diff_position_executions,
    is_order_close_fulfilled,
    is_order_entry_fulfilled,
    normalize_etoro_order_payload,
    position_ids_from_order_status,
    positions_from_order_lookup,
    resolve_bracket_stop_loss_rate,
    resolve_ladder_close_units,
    round_etoro_price,
    round_etoro_units,
    round_up_whole_units,
)


def test_round_etoro_price_normalizes_float_noise():
    assert round_etoro_price(1999.0800000000002) == 1999.08


def test_round_etoro_units_normalizes_to_six_decimals():
    assert round_etoro_units(2.1291234567) == 2.129123


def test_round_up_whole_units_ceils_fractional_trims():
    assert round_up_whole_units(12.5) == 13
    assert round_up_whole_units(12.0) == 12
    assert round_up_whole_units(0.4) == 1


def test_resolve_ladder_close_units_whole_partial():
    units, full = resolve_ladder_close_units(12.5, 50.0)
    assert full is False
    assert units == 13.0


def test_resolve_ladder_close_units_full_when_round_up_exceeds_holdings():
    units, full = resolve_ladder_close_units(12.5, 12.5)
    assert full is True
    assert units is None


def test_normalize_etoro_order_payload_rounds_money_fields():
    payload = normalize_etoro_order_payload({
        "action": "open",
        "amount": 1999.0800000000002,
        "stopLossRate": 98.00000000000001,
        "units": 1.269991,
    })
    assert payload["amount"] == 1999.08
    assert payload["stopLossRate"] == 98.0
    assert payload["units"] == 1.269991


def test_normalize_etoro_order_payload_rounds_units_to_deduct_to_six_decimals():
    payload = normalize_etoro_order_payload({
        "InstrumentID": 123,
        "UnitsToDeduct": 703.1259876,
    })
    assert payload["UnitsToDeduct"] == 703.125988


def test_resolve_bracket_stop_loss_rate_uses_explicit_value():
    assert resolve_bracket_stop_loss_rate(100.0, 80.0, invested_amount=1000.0) == 80.0


def test_compute_stop_loss_price_uses_amount_when_set():
    assert compute_stop_loss_price(100.0, 1000.0, stop_loss_amount=20.0, short_percent=10.0) == 98.0


def test_compute_stop_loss_price_falls_back_to_percent_without_amount():
    assert compute_stop_loss_price(100.0, 1000.0, stop_loss_amount=None, short_percent=10.0) == 90.0


def test_resolve_bracket_stop_loss_rate_defaults_from_max_loss_budget():
    # Invest $1000, max loss $20 => 2% below entry => SL rate 98 on LTP 100
    assert resolve_bracket_stop_loss_rate(100.0, None, invested_amount=1000.0) == round(
        100.0 * (1 - DEFAULT_BRACKET_STOP_LOSS_AMOUNT / 1000.0),
        4,
    )


def test_resolve_bracket_stop_loss_rate_requires_ltp_for_default():
    with pytest.raises(ValueError):
        resolve_bracket_stop_loss_rate(None, None, invested_amount=1000.0)


def test_resolve_bracket_stop_loss_rate_requires_invested_amount_for_default():
    with pytest.raises(ValueError):
        resolve_bracket_stop_loss_rate(100.0, None)


def test_resolve_bracket_stop_loss_rate_rejects_investment_smaller_than_loss_budget():
    with pytest.raises(ValueError):
        resolve_bracket_stop_loss_rate(100.0, None, invested_amount=DEFAULT_BRACKET_STOP_LOSS_AMOUNT)


def test_apply_v1_bracket_fields_omits_take_profit_when_not_provided():
    payload = apply_v1_bracket_fields({}, stop_loss_rate=80.0, take_profit_rate=None)
    assert payload["StopLossRate"] == 80.0
    assert payload["IsNoStopLoss"] is False
    assert payload["IsNoTakeProfit"] is True
    assert "TakeProfitRate" not in payload


def test_apply_v1_bracket_fields_includes_take_profit_when_provided():
    payload = apply_v1_bracket_fields({}, stop_loss_rate=80.0, take_profit_rate=120.0)
    assert payload["TakeProfitRate"] == 120.0
    assert payload["IsNoTakeProfit"] is False


def test_apply_v2_bracket_fields_omits_take_profit_when_not_provided():
    payload = apply_v2_bracket_fields({}, stop_loss_rate=80.0, take_profit_rate=None)
    assert payload["stopLossRate"] == 80.0
    assert "takeProfitRate" not in payload


def test_position_ids_from_order_status_supports_v2_and_v1_shapes():
    assert position_ids_from_order_status({"positionExecutions": [{"positionId": 42}]}) == ["42"]
    assert position_ids_from_order_status({"positions": [{"positionID": 7}]}) == ["7"]


def test_is_order_close_fulfilled_requires_empty_positions_to_close_and_zero_units():
    lookup = {
        "positionsToClose": [],
        "positionExecutions": [
            {"positionId": 1, "state": "closed", "remainingUnits": 0},
            {"positionId": 2, "state": "closed", "remainingUnits": 0},
        ],
    }
    assert is_order_close_fulfilled(lookup) is True
    assert is_order_close_fulfilled({**lookup, "positionsToClose": [99]}) is False


def test_is_order_entry_fulfilled_detects_open_units():
    lookup = {
        "action": "open",
        "status": {"id": 1, "name": "Executed"},
        "positionExecutions": [{"positionId": 7, "state": "open", "remainingUnits": 1.5}],
    }
    assert is_order_entry_fulfilled(lookup) is True
    assert classify_order_poll_outcome(lookup) == "fulfilled"


def test_classify_order_poll_outcome_rejects_cancelled_orders():
    lookup = {"status": {"id": 2, "name": "Cancelled"}}
    assert classify_order_poll_outcome(lookup) == "rejected"


def test_classify_order_poll_outcome_treats_v2_filled_id_as_fulfilled_not_rejected():
    lookup = {
        "action": "open",
        "status": {"id": 3, "name": "Filled", "errorCode": 0},
        "positionExecutions": [
            {"positionId": 3535583983, "state": "open", "remainingUnits": 1.269991},
        ],
    }
    assert classify_order_poll_outcome(lookup) == "fulfilled"


def test_diff_position_executions_detects_open_update_and_close():
    previous = {
        "lastUpdate": "2026-01-01T00:00:00Z",
        "positionExecutions": [{"positionId": 7, "state": "open", "remainingUnits": 2.0}],
    }
    current = {
        "lastUpdate": "2026-01-01T00:00:05Z",
        "positionExecutions": [{"positionId": 7, "state": "closed", "remainingUnits": 0}],
    }
    changes = diff_position_executions(previous, current)
    assert len(changes) == 1
    assert changes[0]["change_type"] == "POSITION_CLOSED"


def test_positions_from_order_lookup_deduplicates_positions_and_executions():
    lookup = {
        "positions": [{"positionID": 7, "units": 1.5}],
        "positionExecutions": [
            {"positionId": 7, "executedUnits": 1.5},
            {"positionId": 9, "executedUnits": 0.5},
        ],
    }
    positions = positions_from_order_lookup(lookup)
    assert len(positions) == 2
    assert positions[0]["positionID"] == 7
    assert positions[1]["positionId"] == 9
