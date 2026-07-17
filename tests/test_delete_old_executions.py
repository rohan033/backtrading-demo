from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from api.server import _is_deletable_stopped_execution
from control_plane.engine_registry import EngineRegistry


def _controlled_engine(
    execution_id: str,
    *,
    status: str = "stopped",
    created_at: str,
    pid: int | None = None,
) -> dict:
    return {
        "id": execution_id,
        "status": status,
        "pid": pid,
        "created_at": created_at,
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": {"executor_id": execution_id},
        },
    }


def test_is_deletable_stopped_execution_respects_age_and_status():
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    old_created = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    recent_created = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()

    assert _is_deletable_stopped_execution(
        _controlled_engine("old-stopped", status="stopped", created_at=old_created),
        cutoff,
    )
    assert not _is_deletable_stopped_execution(
        _controlled_engine("recent-stopped", status="stopped", created_at=recent_created),
        cutoff,
    )
    assert not _is_deletable_stopped_execution(
        _controlled_engine("old-running", status="running", created_at=old_created, pid=999),
        cutoff,
    )


def test_is_deletable_stopped_execution_ignores_stale_pid():
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    old_created = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    assert _is_deletable_stopped_execution(
        _controlled_engine("old-stopped", status="stopped", created_at=old_created, pid=6559),
        cutoff,
    )


def test_is_deletable_stopped_execution_all_stopped_ignores_age():
    cutoff = datetime.now(timezone.utc)
    recent_created = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    assert _is_deletable_stopped_execution(
        _controlled_engine("recent-stopped", status="stopped", created_at=recent_created),
        cutoff,
        all_stopped=True,
    )
    assert _is_deletable_stopped_execution(
        _controlled_engine("stale-exec", status="stale", created_at=recent_created),
        cutoff,
        all_stopped=True,
    )
    assert not _is_deletable_stopped_execution(
        _controlled_engine("running-exec", status="running", created_at=recent_created),
        cutoff,
        all_stopped=True,
    )
    assert not _is_deletable_stopped_execution(
        _controlled_engine("scheduled-exec", status="scheduled", created_at=recent_created),
        cutoff,
        all_stopped=True,
    )


def test_delete_old_executions_endpoint(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    registry = EngineRegistry(str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))
    monkeypatch.setattr("api.server.engine_registry", registry)

    from api.server import app
    old_created = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    recent_created = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()

    registry.upsert_engine({
        "id": "old-stopped-exec",
        "label": "old-stopped",
        "broker": "etoro",
        "symbol": "AAPL",
        "strategy_name": "one-percent",
        "status": "stopped",
        "created_at": old_created,
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": {"executor_id": "old-stopped-exec"},
        },
    })
    registry.upsert_engine({
        "id": "recent-stopped-exec",
        "label": "recent-stopped",
        "broker": "etoro",
        "symbol": "MSFT",
        "strategy_name": "one-percent",
        "status": "stopped",
        "created_at": recent_created,
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": {"executor_id": "recent-stopped-exec"},
        },
    })
    registry.upsert_engine({
        "id": "old-running-exec",
        "label": "old-running",
        "broker": "etoro",
        "symbol": "TSLA",
        "strategy_name": "one-percent",
        "status": "running",
        "created_at": old_created,
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": {"executor_id": "old-running-exec"},
        },
    })

    client = TestClient(app)
    response = client.post(
        "/api/control/executions/bulk/delete-old",
        json={"older_than_days": 30},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] is True
    assert payload["data"]["count"] == 1
    assert payload["data"]["deleted"] == ["old-stopped-exec"]
    assert registry.get_engine("old-stopped-exec") is None
    assert registry.get_engine("recent-stopped-exec") is not None
    assert registry.get_engine("old-running-exec") is not None


def test_delete_old_executions_zero_days_deletes_all_stopped(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    registry = EngineRegistry(str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))
    monkeypatch.setattr("api.server.engine_registry", registry)

    from api.server import app

    recent_created = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    for execution_id in ("recent-stopped-a", "recent-stopped-b"):
        registry.upsert_engine({
            "id": execution_id,
            "label": execution_id,
            "broker": "etoro",
            "symbol": "AAPL",
            "strategy_name": "one-percent",
            "status": "stopped",
            "created_at": recent_created,
            "metadata": {
                "source": "controlled_execution",
                "executor_payload": {"executor_id": execution_id},
            },
        })

    client = TestClient(app)
    response = client.post(
        "/api/control/executions/bulk/delete-old",
        json={"older_than_days": 0},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["data"]["count"] == 2
    assert registry.get_engine("recent-stopped-a") is None
    assert registry.get_engine("recent-stopped-b") is None


def test_delete_controlled_execution_endpoint(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    registry = EngineRegistry(str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))
    monkeypatch.setattr("api.server.engine_registry", registry)

    from api.server import app

    execution_id = "delete-me-exec"
    registry.upsert_engine({
        "id": execution_id,
        "label": execution_id,
        "broker": "etoro",
        "symbol": "AAPL",
        "strategy_name": "one-percent",
        "status": "stopped",
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": {"executor_id": execution_id},
        },
    })

    client = TestClient(app)
    response = client.delete(f"/api/control/executions/{execution_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] is True
    assert payload["data"]["deleted"] is True
    assert registry.get_engine(execution_id) is None
