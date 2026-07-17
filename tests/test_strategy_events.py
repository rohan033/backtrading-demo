from event.strategy_events import STRATEGY_DEPLOYED, strategy_details_from_engine
from event.telegram_format import (
    format_strategy_telegram_message,
    format_telegram_event,
    format_ui_position_closed_message,
)


def test_strategy_details_from_engine():
    engine = {
        "id": "angel-ibm-default-live",
        "status": "scheduled",
        "broker": "angel",
        "symbol": "IBM",
        "token": "1234",
        "strategy_name": "default",
        "account_env": "live",
        "metadata": {
            "scheduled_start_at": "2026-06-02T09:15:00+05:30",
            "executor_payload": {"exchange": "NSE"},
        },
    }
    details = strategy_details_from_engine(engine, previous_state="pending", trigger="create")
    assert details["execution_id"] == "angel-ibm-default-live"
    assert details["state"] == "scheduled"
    assert details["symbol"] == "IBM"
    assert details["previous_state"] == "pending"


def test_format_telegram_strategy_deployed():
    text = format_strategy_telegram_message(
        STRATEGY_DEPLOYED,
        {
            "execution_id": "angel-ibm-default-live",
            "state": "starting",
            "symbol": "IBM",
            "exchange": "NSE",
            "broker": "angel",
            "account_env": "live",
            "strategy_name": "default",
            "strategy_type": "default",
            "previous_state": "pending",
            "trigger": "manual",
            "max_available_capital": 100_000,
            "reference_close": 245.5,
            "long_percent": 1.0,
            "short_percent": 10.0,
            "initial_threshold": 0.2,
            "take_profit_price": 247.96,
            "stop_loss_price": 220.95,
            "estimated_quantity": 407,
            "estimated_invested": 99_918.5,
            "estimated_profit_at_tp": 999.18,
            "estimated_loss_at_sl": 9_991.85,
            "entry_trigger_label": "+0.20% vs ref. close",
        },
    )
    assert "Strategy deployed" in text
    assert "IBM" in text
    assert "starting" in text
    assert "manual" in text
    assert "₹100,000.00" in text
    assert "Take profit" in text
    assert "Stop loss" in text
    assert "407 units" in text
    assert "<pre>" in text


def test_strategy_details_enriched_from_engine():
    from event.strategy_events import strategy_details_from_engine

    engine = {
        "id": "etoro-ionq-default-demo",
        "status": "scheduled",
        "broker": "etoro",
        "symbol": "IONQ",
        "token": "123",
        "strategy_name": "default",
        "account_env": "demo",
        "metadata": {
            "executor_payload": {
                "close_price": 293.18,
                "long_percent": 1.0,
                "short_percent": 10.0,
                "initial_threshold": 0.2,
                "max_available_capital": 5000,
                "allow_partial_stocks": True,
                "exchange": "NASDAQ",
            },
        },
    }
    details = strategy_details_from_engine(engine, trigger="create")
    assert details["reference_close"] == 293.18
    assert details["estimated_quantity"] > 0
    assert details["take_profit_price"] > details["reference_close"]
    assert details["stop_loss_price"] < details["reference_close"]


def test_format_ui_position_closed_message():
    text = format_ui_position_closed_message({
        "account_env": "demo",
        "ticker": "VEEE",
        "symbol_name": "Twin Vee PowerCats Co",
        "buy_price": 981.78,
        "sell_price": 982.02,
        "pnl": 24.0,
        "pnl_pct": 0.02,
        "take_profit_config": "TP 5% (on)",
        "stop_loss_config": "SL 1 $ (off)",
        "source": "positions",
        "close_reason": "manual",
        "position_id": "123456789",
    })
    assert "VEEE" in text
    assert "DEMO" in text
    assert "Buy" in text
    assert "Sell" in text
    assert "P&L" in text
    assert "TP  5% (on)" in text
    assert "SL  1 $ (off)" in text
    assert "Positions" in text
