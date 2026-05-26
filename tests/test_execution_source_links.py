from control_plane.ai_research_store import AiResearchStore
from control_plane.engine_registry import EngineRegistry
from control_plane.execution_source_links import ensure_research_source_on_engine


def test_find_research_session_by_action_execution_id(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    store = AiResearchStore()
    session = store.create_session(title="Test")
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "INFY",
            "payload": {"execution_id": "exec-123", "symbol": "INFY-EQ"},
        },
    )

    found = store.find_research_session_for_execution("exec-123")
    assert found == session_id


def test_find_research_session_by_symbol_fingerprint(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    store = AiResearchStore()
    session = store.create_session(title="Test")
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "TSLA",
            "payload": {
                "broker": "etoro",
                "symbol": "TSLA",
                "token": "1111",
                "close_price": 434.07,
            },
        },
    )

    engine = {
        "id": "etoro-tsla-strategy-one-percent-20260526184559",
        "broker": "etoro",
        "symbol": "TSLA",
        "token": "1111",
        "metadata": {
            "execution_config": {"broker": "etoro", "close_price": 434.07},
            "executor_payload": {"close_price": 434.07},
        },
    }

    found = store.find_research_session_for_execution(engine["id"], engine)
    assert found == session_id


def test_ensure_research_source_backfills_metadata(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    store = AiResearchStore()
    registry = EngineRegistry()
    session = store.create_session(title="Test")
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "TSLA",
            "payload": {"symbol": "TSLA", "token": "1111", "close_price": 434.07, "broker": "etoro"},
        },
    )

    registry.upsert_engine(
        {
            "id": "etoro-tsla-strategy-one-percent-test",
            "broker": "etoro",
            "symbol": "TSLA",
            "token": "1111",
            "strategy_name": "one-percent",
            "status": "scheduled",
            "metadata": {
                "source": "controlled_execution",
                "execution_config": {"broker": "etoro", "close_price": 434.07},
                "executor_payload": {"close_price": 434.07},
            },
        }
    )

    engine = registry.get_engine("etoro-tsla-strategy-one-percent-test")
    updated = ensure_research_source_on_engine(registry, store, engine)
    metadata = updated["metadata"]

    assert metadata["source_id"] == "ai_research"
    assert metadata["source_meta_id"] == session_id
