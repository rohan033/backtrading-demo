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
