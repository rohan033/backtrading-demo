import os
import tempfile

from control_plane.watchlist_store import WatchlistStore


def test_watchlist_crud():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "watchlists.db")
        store = WatchlistStore(db_path=path)

        created = store.create_watchlist("Momentum")
        assert created["name"] == "Momentum"
        assert created["symbols"] == []

        updated = store.add_symbol(
            created["id"],
            symboltoken="3045",
            tradingsymbol="SBIN",
            exchange="NSE",
        )
        assert len(updated["symbols"]) == 1
        assert updated["symbols"][0]["tradingsymbol"] == "SBIN"

        renamed = store.rename_watchlist(created["id"], "Banks")
        assert renamed["name"] == "Banks"

        listed = store.list_watchlists()
        assert len(listed) == 1
        assert listed[0]["symbols"][0]["symboltoken"] == "3045"

        store.remove_symbol(created["id"], "3045")
        assert store.get_watchlist(created["id"])["symbols"] == []

        assert store.delete_watchlist(created["id"])
        assert store.list_watchlists() == []


def test_find_symbol_by_ticker_prefers_us_equity():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "watchlists.db")
        store = WatchlistStore(db_path=path)

        created = store.create_watchlist("Movers", broker="etoro", account_env="demo")
        store.add_symbol(
            created["id"],
            symboltoken="1001",
            tradingsymbol="STX",
            exchange="ETORO",
            symbol="Stacks",
        )
        store.add_symbol(
            created["id"],
            symboltoken="2002",
            tradingsymbol="STX.US",
            exchange="ETORO",
            symbol="Seagate",
        )

        hit = store.find_symbol_by_ticker(broker="etoro", account_env="demo", ticker="STX")
        assert hit is not None
        assert hit["symboltoken"] == "2002"
        assert hit["tradingsymbol"] == "STX.US"

        exact = store.find_symbol_by_ticker(broker="etoro", account_env="demo", ticker="STX.US")
        assert exact is not None
        assert exact["symboltoken"] == "2002"

        other_env = store.find_symbol_by_ticker(broker="etoro", account_env="live", ticker="STX")
        assert other_env is None


def test_merge_watchlist_into_search_rows_promotes_known_id():
    from control_plane.instrument_resolve import merge_watchlist_into_search_rows
    from control_plane import watchlist_store as wl_mod

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "watchlists.db")
        store = WatchlistStore(db_path=path)
        created = store.create_watchlist("PM", broker="etoro", account_env="demo")
        store.add_symbol(
            created["id"],
            symboltoken="1051632",
            tradingsymbol="ZYBT.US",
            exchange="ETORO",
            symbol="ZYBT",
        )

        prev = wl_mod._store
        wl_mod._store = store
        try:
            rows = merge_watchlist_into_search_rows(
                "etoro",
                "demo",
                "ZYBT",
                [
                    {
                        "tradingsymbol": "ZYBT",
                        "symboltoken": "999",
                        "exchange": "ETORO",
                        "name": "Wrong ZYBT",
                    }
                ],
            )
            assert rows[0]["symboltoken"] == "1051632"
            assert rows[0]["from_watchlist"] is True
            assert rows[0]["tradingsymbol"] == "ZYBT.US"
            assert any(r.get("symboltoken") == "999" for r in rows[1:])
        finally:
            wl_mod._store = prev


def test_watchlist_symbol_metadata_is_persisted_and_updated():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "metadata.db")
        store = WatchlistStore(db_path=path)

        created = store.create_watchlist("Crypto", broker="etoro")
        updated = store.add_symbol(
            created["id"],
            symboltoken="100000",
            tradingsymbol="BTC",
            exchange="ETORO",
            symbol="Bitcoin",
            internal_asset_class_name="Crypto",
            instrument_display_name="Bitcoin",
            logo35x35="https://example.test/btc-35.png",
            logo50x50="https://example.test/btc-50.png",
            logo150x150="https://example.test/btc-150.png",
            raw_metadata={"internalInstrumentId": 100000},
        )

        symbol = updated["symbols"][0]
        assert symbol["internal_asset_class_name"] == "Crypto"
        assert symbol["instrument_display_name"] == "Bitcoin"
        assert symbol["logo35x35"] == "https://example.test/btc-35.png"
        assert symbol["logo50x50"] == "https://example.test/btc-50.png"
        assert symbol["logo150x150"] == "https://example.test/btc-150.png"
        assert symbol["raw_metadata_json"] == '{"internalInstrumentId":100000}'
        assert symbol["metadata_updated_at"]

        refreshed = store.add_symbol(
            created["id"],
            symboltoken="100000",
            tradingsymbol="BTC",
            exchange="ETORO",
            logo150x150="https://example.test/btc-new.png",
        )
        assert len(refreshed["symbols"]) == 1
        assert refreshed["symbols"][0]["logo35x35"] == "https://example.test/btc-35.png"
        assert refreshed["symbols"][0]["logo150x150"] == "https://example.test/btc-new.png"


def test_watchlist_panels():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "panels.db")
        store = WatchlistStore(db_path=path)

        panels = store.list_panels()
        assert len(panels) == 1
        default_id = panels[0]["id"]
        assert panels[0]["name"] == "Default"

        created = store.create_panel("Momentum")
        assert created["name"] == "Momentum"

        wl = store.create_watchlist("Alpha", panel_id=created["id"])
        assert wl["panel_id"] == created["id"]

        renamed = store.update_panel(created["id"], name="Hot")
        assert renamed["name"] == "Hot"

        listed = store.list_panels()
        assert len(listed) == 2
        hot = next(p for p in listed if p["id"] == created["id"])
        assert hot["watchlist_count"] == 1

        assert store.delete_panel(created["id"])
        moved = store.get_watchlist(wl["id"])
        assert moved["panel_id"] == default_id

        assert not store.delete_panel(default_id)
