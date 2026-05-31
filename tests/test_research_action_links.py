from control_plane.ai_research_store import AiResearchStore
from control_plane.engine_registry import EngineRegistry
from control_plane.execution_source_links import (
    extract_execution_id_from_tool_payload,
    symbol_from_action,
    symbol_from_title,
)


def test_symbol_from_title_extracts_ticker():
    assert symbol_from_title("USAR rare earth breakout") == "USAR"
    assert symbol_from_title("HYLN momentum breakout") == "HYLN"


def test_symbol_from_action_uses_title_when_payload_empty():
    action = {"title": "USAR post-filing momentum", "payload": {}}
    assert symbol_from_action(action) == "USAR"


def test_extract_execution_id_from_start_strategy_path():
    payload = {
        "tool_name": "start_strategy",
        "path": "/api/control/executions/etoro-tsla-strategy-one-percent/start",
    }
    assert extract_execution_id_from_tool_payload(payload) == "etoro-tsla-strategy-one-percent"


def test_link_execution_to_matching_action(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    store = AiResearchStore()
    session = store.create_session(title="Link test")
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "IPWR momentum setup",
            "payload": {"broker": "etoro", "close_price": 12.5},
        },
    )

    engine = {
        "id": "etoro-ipwr-strategy-one-percent-test",
        "broker": "etoro",
        "symbol": "IPWR",
        "token": "6846",
        "status": "running",
        "metadata": {
            "source_id": "ai_research",
            "source_meta_id": session_id,
            "execution_config": {"broker": "etoro", "close_price": 12.5},
            "executor_payload": {"close_price": 12.5},
        },
    }

    updated = store.link_execution_to_session_actions(session_id, engine["id"], engine)
    actions = updated["actions"]
    assert actions[0]["payload"]["execution_id"] == engine["id"]
    assert actions[0]["status"] == "running"


def test_sync_session_action_links(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    store = AiResearchStore()
    registry = EngineRegistry()
    session = store.create_session(title="Sync test")
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "TSLA",
            "payload": {"symbol": "TSLA", "token": "1111", "broker": "etoro", "close_price": 100},
        },
    )

    registry.upsert_engine(
        {
            "id": "etoro-tsla-strategy-sync-test",
            "broker": "etoro",
            "symbol": "TSLA",
            "token": "1111",
            "strategy_name": "one-percent",
            "status": "scheduled",
            "metadata": {
                "source_id": "ai_research",
                "source_meta_id": session_id,
                "execution_config": {"broker": "etoro", "close_price": 100},
                "executor_payload": {"close_price": 100},
            },
        }
    )

    synced = store.sync_session_action_links(session_id, registry)
    assert synced["actions"][0]["payload"]["execution_id"] == "etoro-tsla-strategy-sync-test"
    assert synced["actions"][0]["status"] == "scheduled"
