"""Unit tests for eToro close settlement from trade/history."""

from control_plane.etoro_close_settle import (
    apply_settlement_to_notify,
    settled_fields_from_closed_trade,
)


def test_settled_fields_match_zybt_trade_story():
    row = {
        "netProfit": 136.98,
        "closeRate": 2.4022,
        "closeTimestamp": "2026-07-20T15:25:31.703Z",
        "positionId": 3519103241,
        "instrumentId": 1052448,
        "isBuy": True,
        "leverage": 1,
        "openRate": 2.25,
        "openTimestamp": "2026-07-20T15:20:01.177Z",
        "orderId": 1535408835,
        "investment": 2025.0,
        "initialInvestment": 2025.0,
        "fees": 0.0,
        "units": 900.0,
    }
    fields = settled_fields_from_closed_trade(row)
    assert fields is not None
    assert fields["buy_price"] == 2.25
    assert fields["sell_price"] == 2.4022
    assert fields["pnl"] == 136.98
    assert abs(fields["pnl_pct"] - 6.76) < 0.01
    assert fields["settled_from"] == "trade_history"


def test_apply_settlement_overwrites_client_estimate():
    class Notify:
        def __init__(self):
            self.buy_price = 2.25
            self.sell_price = 2.48
            self.pnl = 207.0
            self.pnl_pct = 10.22
            self.source = "positions"
            self.ticker = "ZYBT"

        def model_copy(self, *, update):
            next_notify = Notify()
            for key, value in self.__dict__.items():
                setattr(next_notify, key, value)
            for key, value in update.items():
                setattr(next_notify, key, value)
            return next_notify

    notify = Notify()
    settled = settled_fields_from_closed_trade({
        "openRate": 2.25,
        "closeRate": 2.4022,
        "netProfit": 136.98,
        "investment": 2025.0,
        "units": 900.0,
    })
    merged = apply_settlement_to_notify(notify, settled)
    assert merged.sell_price == 2.4022
    assert merged.pnl == 136.98
    assert abs(merged.pnl_pct - 6.76) < 0.01
    # Original estimate must not leak through.
    assert merged.sell_price != 2.48
