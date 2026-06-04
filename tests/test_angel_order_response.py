import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brokers.angel.trading_client import parse_angel_order_response, PERMANENT_ANGEL_ORDER_ERROR_CODES


def test_parse_success():
    res = parse_angel_order_response({
        "status": True,
        "data": {"orderid": "123", "uniqueorderid": "u-123"},
    })
    assert res["order_id"] == "123"
    assert res["unique_order_id"] == "u-123"


def test_parse_permanent_failure():
    res = parse_angel_order_response({
        "status": False,
        "errorcode": "AB4036",
        "message": "cautionary listings",
    })
    assert res.get("order_id") is None
    assert res["error_code"] == "AB4036"
    assert res["permanent_failure"] is True
    assert "AB4036" in PERMANENT_ANGEL_ORDER_ERROR_CODES


def test_parse_transient_failure():
    res = parse_angel_order_response({
        "status": False,
        "errorcode": "AB1000",
        "message": "temporary",
    })
    assert res["permanent_failure"] is False


if __name__ == "__main__":
    test_parse_success()
    test_parse_permanent_failure()
    test_parse_transient_failure()
    print("ok")
