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
