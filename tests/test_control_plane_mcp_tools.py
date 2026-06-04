from api.control_plane_mcp_tools import CREATE_STRATEGY_TOOL
from control_plane.execution_source_links import tool_call_created_execution


def test_create_strategy_tool_detected_as_execution_create():
    assert tool_call_created_execution({"tool_name": CREATE_STRATEGY_TOOL, "tool_status": "completed"})


def test_openapi_create_strategy_operation_id():
    from api.server import app

    spec = app.openapi()
    post = spec["paths"]["/api/control/executions"]["post"]
    assert post["operationId"] == CREATE_STRATEGY_TOOL


def test_openapi_get_strategy_tools():
    from api.server import app

    spec = app.openapi()
    assert spec["paths"]["/api/control/executions"]["get"]["operationId"] == "get_strategies"
    assert (
        spec["paths"]["/api/control/executions/{execution_id}"]["get"]["operationId"]
        == "get_strategy"
    )
    assert spec["paths"]["/api/search"]["get"]["operationId"] == "search_scrip"
    assert spec["paths"]["/api/historical/{token}"]["get"]["operationId"] == "get_historical_candles"
