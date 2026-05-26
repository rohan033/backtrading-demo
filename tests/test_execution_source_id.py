import pytest
from pydantic import ValidationError

from api.server import ControlPlaneExecutionRequest, _controlled_execution_payload
from control_plane.execution_sources import (
    EXECUTION_SOURCE_AI_CHATBOT_PANEL,
    EXECUTION_SOURCE_AI_RESEARCH,
    EXECUTION_SOURCE_USER,
)


def _sample_request(**overrides):
    base = dict(
        symbol="INFY-EQ",
        token="1594",
        close_price=1500.0,
    )
    base.update(overrides)
    return ControlPlaneExecutionRequest(**base)


def test_controlled_execution_defaults_source_id_to_user():
    _, _, engine_config = _controlled_execution_payload(_sample_request())
    metadata = engine_config["metadata"]

    assert metadata["source_id"] == EXECUTION_SOURCE_USER
    assert metadata["execution_config"]["source_id"] == EXECUTION_SOURCE_USER


def test_controlled_execution_persists_ai_research_source_id():
    _, _, engine_config = _controlled_execution_payload(
        _sample_request(
            source_id=EXECUTION_SOURCE_AI_RESEARCH,
            source_meta_id="research-session-123",
        ),
    )
    metadata = engine_config["metadata"]

    assert metadata["source_id"] == EXECUTION_SOURCE_AI_RESEARCH
    assert metadata["source_meta_id"] == "research-session-123"
    assert metadata["execution_config"]["source_id"] == EXECUTION_SOURCE_AI_RESEARCH
    assert metadata["execution_config"]["source_meta_id"] == "research-session-123"


def test_controlled_execution_source_meta_id_optional():
    _, _, engine_config = _controlled_execution_payload(_sample_request())
    metadata = engine_config["metadata"]

    assert metadata.get("source_meta_id") is None
    assert metadata["execution_config"].get("source_meta_id") is None


def test_controlled_execution_clears_source_meta_id_for_user_source():
    _, _, engine_config = _controlled_execution_payload(
        _sample_request(source_id=EXECUTION_SOURCE_USER, source_meta_id="should-be-cleared"),
    )
    metadata = engine_config["metadata"]

    assert metadata.get("source_meta_id") is None
    assert metadata["execution_config"].get("source_meta_id") is None


def test_controlled_execution_clears_source_meta_id_for_ai_chatbot_panel():
    _, _, engine_config = _controlled_execution_payload(
        _sample_request(
            source_id=EXECUTION_SOURCE_AI_CHATBOT_PANEL,
            source_meta_id="should-be-cleared",
        ),
    )
    metadata = engine_config["metadata"]

    assert metadata.get("source_meta_id") is None
    assert metadata["execution_config"].get("source_meta_id") is None


def test_controlled_execution_requires_source_meta_id_for_ai_research():
    with pytest.raises(ValidationError):
        _sample_request(source_id=EXECUTION_SOURCE_AI_RESEARCH)


def test_controlled_execution_persists_ai_chatbot_panel_source_id():
    _, _, engine_config = _controlled_execution_payload(
        _sample_request(source_id=EXECUTION_SOURCE_AI_CHATBOT_PANEL),
    )
    metadata = engine_config["metadata"]

    assert metadata["source_id"] == EXECUTION_SOURCE_AI_CHATBOT_PANEL
    assert metadata["execution_config"]["source_id"] == EXECUTION_SOURCE_AI_CHATBOT_PANEL
