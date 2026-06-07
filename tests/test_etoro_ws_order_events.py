from brokers.etoro.ws_order_events import map_tracked_order_status, map_websocket_update


def test_map_tracked_order_status_v2_filled_lookup_is_order_filled():
    lookup = {
        "status": {"id": 3, "name": "Filled", "errorCode": 0},
        "positionExecutions": [
            {
                "positionId": 3535583983,
                "state": "open",
                "remainingUnits": 1.269991,
                "openingData": {"units": 1.269991},
            },
        ],
    }
    assert map_tracked_order_status(lookup) == "ORDER_FILLED"


def test_map_websocket_update_v1_rejected_without_name():
    content = {"StatusID": 3, "ErrorCode": 0}
    assert map_websocket_update("Trading.OrderForOpen.Update", content) == "ORDER_REJECTED"


def test_map_websocket_update_v1_executed():
    content = {"StatusID": 1, "ExecutedUnits": 2.5, "ErrorCode": 0}
    assert map_websocket_update("Trading.OrderForOpen.Update", content) == "ORDER_FILLED"
