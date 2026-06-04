import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brokers.angel.ws_order_events import map_angel_order_status


def _payload(textual_status: str, code: str = "AB01") -> dict:
    return {
        "order-status": code,
        "orderData": {"status": textual_status, "orderid": "1"},
    }


def test_pending_status():
    assert map_angel_order_status(_payload("pending", "AB09")) == "ORDER_PENDING"


def test_open_pending_is_pending_not_open():
    assert map_angel_order_status(_payload("open pending", "AB01")) == "ORDER_PENDING"


def test_open_status():
    assert map_angel_order_status(_payload("open", "AB01")) == "ORDER_OPEN"


def test_filled_status():
    assert map_angel_order_status(_payload("complete", "AB05")) == "ORDER_FILLED"


if __name__ == "__main__":
    test_pending_status()
    test_open_pending_is_pending_not_open()
    test_open_status()
    test_filled_status()
    print("ok")
