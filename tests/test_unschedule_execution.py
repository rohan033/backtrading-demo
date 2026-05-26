from api.server import _clear_schedule_from_metadata


def test_clear_schedule_from_metadata():
    metadata = {
        "source": "controlled_execution",
        "scheduled_start_at": "2026-05-27T13:30:00+00:00",
        "trading_day": "2026-05-27",
        "market_open_label": "US market open",
        "schedule_label": "Wed 27 May",
        "execution_config": {
            "symbol": "HYLN",
            "schedule_enabled": True,
            "scheduled_date": "2026-05-27",
            "start_immediately": False,
        },
        "executor_payload": {"executor_id": "test"},
    }

    cleaned = _clear_schedule_from_metadata(metadata)

    assert "scheduled_start_at" not in cleaned
    assert "trading_day" not in cleaned
    assert cleaned["execution_config"]["schedule_enabled"] is False
    assert cleaned["execution_config"]["scheduled_date"] is None
    assert cleaned["executor_payload"]["executor_id"] == "test"
