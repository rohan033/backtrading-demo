from control_plane.trades_pnl_store import TradesPnlStore


def test_records_completed_positions_ui_trade(tmp_path):
    store = TradesPnlStore(str(tmp_path / "control_plane.db"))

    row = store.record_completed_ui_trade(
        position_id="position-42",
        source="positions",
        symbol="MU",
        entry_price=100,
        exit_price=105,
        pnl=50,
        pnl_pct=5,
        close_reason="manual",
    )

    assert row is not None
    assert row["tradingsymbol"] == "MU"
    assert row["entry_price"] == 100
    assert row["exit_price"] == 105
    assert row["pnl"] == 50
    assert row["pnl_pct"] == 5
    assert row["status"] == "closed"
    assert row["source"] == "positions"


def test_completed_ui_trade_is_idempotent_by_position(tmp_path):
    store = TradesPnlStore(str(tmp_path / "control_plane.db"))
    values = {
        "position_id": "position-42",
        "source": "bracket",
        "symbol": "MU",
        "entry_price": 100,
        "exit_price": 95,
        "pnl": -50,
        "pnl_pct": -5,
    }

    store.record_completed_ui_trade(**values)
    store.record_completed_ui_trade(**values)

    assert len(store.list_trades()) == 1


def test_incomplete_ui_close_is_not_recorded(tmp_path):
    store = TradesPnlStore(str(tmp_path / "control_plane.db"))

    row = store.record_completed_ui_trade(
        position_id="position-42",
        source="positions",
        symbol="MU",
        entry_price=100,
        exit_price=None,
        pnl=None,
        pnl_pct=None,
    )

    assert row is None
    assert store.list_trades() == []
