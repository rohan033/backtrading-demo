from api.server import _clear_schedule_from_metadata, _unschedule_engine_if_scheduled


class FakeRegistry:
    def __init__(self):
        self.engines = {}
        self.updated = []

    def update_engine(self, execution_id, data):
        engine = self.engines.get(execution_id)
        if not engine:
            return None
        merged = {**engine, **data}
        if "metadata" in data:
            merged["metadata"] = data["metadata"]
        self.engines[execution_id] = merged
        self.updated.append(execution_id)
        return merged


def test_unschedule_engine_if_scheduled_clears_metadata(monkeypatch):
    registry = FakeRegistry()
    execution_id = "scheduled-exec"
    registry.engines[execution_id] = {
        "id": execution_id,
        "status": "scheduled",
        "metadata": {
            "scheduled_start_at": "2026-05-27T13:30:00+00:00",
            "execution_config": {
                "schedule_enabled": True,
                "scheduled_date": "2026-05-27",
            },
        },
    }

    monkeypatch.setattr("api.server.engine_registry", registry)

    updated = _unschedule_engine_if_scheduled(execution_id, registry.engines[execution_id])

    assert updated is not None
    assert updated["status"] == "pending"
    cleaned = _clear_schedule_from_metadata(updated["metadata"])
    assert "scheduled_start_at" not in cleaned
    assert cleaned["execution_config"]["schedule_enabled"] is False


def test_unschedule_engine_if_scheduled_skips_non_scheduled(monkeypatch):
    registry = FakeRegistry()
    execution_id = "pending-exec"
    registry.engines[execution_id] = {
        "id": execution_id,
        "status": "pending",
        "metadata": {},
    }

    monkeypatch.setattr("api.server.engine_registry", registry)

    updated = _unschedule_engine_if_scheduled(execution_id, registry.engines[execution_id])

    assert updated is None
    assert registry.updated == []
