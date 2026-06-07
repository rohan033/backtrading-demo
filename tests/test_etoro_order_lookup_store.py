import json
import os
import tempfile

from brokers.etoro.order_helpers import positions_from_order_lookup
from event.db_event_consumer import DbEventWriter


def test_upsert_and_query_order_lookup_with_positions():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "events.db")
        store = DbEventWriter(db_path=db_path)
        lookup = {
            "orderId": 12345,
            "statusId": 1,
            "positions": [{"positionID": 99, "units": 2.0}],
            "positionExecutions": [{"positionId": 100, "executedUnits": 1.0}],
        }

        store.upsert_order_lookup("12345", lookup, account_env="demo")

        saved_lookup = store.get_order_lookup("12345")
        assert saved_lookup is not None
        assert saved_lookup["lookup"]["statusId"] == 1
        assert saved_lookup["account_env"] == "demo"

        positions = store.get_order_positions("12345")
        assert len(positions) == 2
        position_ids = {row["position_id"] for row in positions}
        assert position_ids == {"99", "100"}

        enriched = store.enrich_orders_snapshot({
            "uid-1": {
                "order_id": "12345",
                "unique_order_id": "uid-1",
                "status": "ORDER_FILLED",
            }
        })
        assert "positions" in enriched["uid-1"]
        assert len(enriched["uid-1"]["positions"]) == 2
        assert enriched["uid-1"]["lookup"]["orderId"] == 12345


def test_enrich_orders_snapshot_leaves_orders_without_lookup_unchanged():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = DbEventWriter(db_path=os.path.join(tmpdir, "events.db"))
        orders = {"uid-2": {"order_id": "999", "status": "placed"}}
        enriched = store.enrich_orders_snapshot(orders)
        assert enriched["uid-2"] == orders["uid-2"]
        assert "positions" not in enriched["uid-2"]
