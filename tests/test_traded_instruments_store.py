import os
import tempfile

from control_plane.traded_instruments_store import TradedInstrumentsStore


def test_upsert_dedupes_and_bumps_trade_count():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradedInstrumentsStore(db_path=os.path.join(tmp, "traded.db"))

        first = store.upsert(
            symboltoken="1001",
            tradingsymbol="aapl",
            instrument_display_name="Apple Inc",
            logo35x35="http://x/aapl.png",
        )
        assert first["tradingsymbol"] == "AAPL"
        assert first["trade_count"] == 1
        assert first["first_traded_at"] == first["last_traded_at"]

        # Second trade on same instrument (same broker/env) dedupes and bumps count.
        second = store.upsert(symboltoken="1001", tradingsymbol="aapl")
        assert second["trade_count"] == 2
        # Existing metadata is preserved when not provided again.
        assert second["logo35x35"] == "http://x/aapl.png"
        assert second["instrument_display_name"] == "Apple Inc"

        listed = store.list_instruments(broker="etoro", account_env="demo")
        assert len(listed) == 1
        assert listed[0]["symboltoken"] == "1001"


def test_scope_is_isolated_by_broker_and_env():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradedInstrumentsStore(db_path=os.path.join(tmp, "traded.db"))

        store.upsert(symboltoken="1001", tradingsymbol="AAPL", account_env="demo")
        store.upsert(symboltoken="1001", tradingsymbol="AAPL", account_env="live")

        assert len(store.list_instruments(account_env="demo")) == 1
        assert len(store.list_instruments(account_env="live")) == 1
        assert len(store.list_instruments()) == 2


def test_upsert_from_position_row_and_remove():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradedInstrumentsStore(db_path=os.path.join(tmp, "traded.db"))

        row = {
            "symboltoken": "2002",
            "tradingsymbol": "MU",
            "symbol": "Micron Technology",
            "instrument_display_name": "Micron Technology",
            "logo50x50": "http://x/mu.png",
            "internal_asset_class_name": "Stocks",
            "position_id": "p9",
        }
        saved = store.upsert_from_position_row(row, account_env="demo")
        assert saved["tradingsymbol"] == "MU"
        assert saved["instrument_display_name"] == "Micron Technology"
        assert saved["internal_asset_class_name"] == "Stocks"
        # Position captures default to not bumping the completed-trade count.
        assert saved["trade_count"] == 1

        assert store.remove(broker="etoro", account_env="demo", symboltoken="2002")
        assert store.list_instruments() == []


def test_upsert_requires_token_and_symbol():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradedInstrumentsStore(db_path=os.path.join(tmp, "traded.db"))
        assert store.upsert(symboltoken="", tradingsymbol="AAPL") is None
        assert store.upsert_from_position_row({"tradingsymbol": "AAPL"}) is None
