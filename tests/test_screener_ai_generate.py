"""Unit tests for AI screener free-text parse helpers."""

from control_plane.screener_ai_generate import (
    parse_screener_generate_payload,
    _sanitize_definition_dict,
)
from control_plane.screener_query import ScreenerDefinition


def test_parse_fenced_screener_json():
    text = """
Here you go:
```json
{
  "name": "Premarket heaters",
  "explanation": "Strong premarket movers",
  "definition": {
    "columns": ["name", "premarket_change", "close"],
    "filters": [{"left": "premarket_change", "operation": "greater", "right": 5}],
    "order_by": "premarket_change",
    "ascending": false,
    "limit": 40,
    "market": "america"
  }
}
```
"""
    parsed = parse_screener_generate_payload(text)
    assert parsed is not None
    assert parsed["name"] == "Premarket heaters"
    assert parsed["definition"]["filters"][0]["left"] == "premarket_change"


def test_sanitize_drops_bad_ops_and_validates():
    raw = {
        "columns": ["name", "close"],
        "filters": [
            {"left": "change", "operation": "greater", "right": 2},
            {"left": "close", "operation": "hack", "right": 1},
        ],
        "order_by": "change",
        "limit": 25,
    }
    cleaned = _sanitize_definition_dict(raw)
    assert len(cleaned["filters"]) == 1
    defn = ScreenerDefinition.from_dict(cleaned)
    assert defn.limit == 25
    assert defn.filters[0].left == "change"


def test_generate_uses_direct_sdk_bridge_without_mcp(monkeypatch):
    """Regression: generate must not go through Strategy AI MCP chat."""
    import asyncio

    from control_plane import screener_ai_generate as mod

    events = [
        {"type": "start", "agent_id": "a1"},
        {
            "type": "done",
            "text": """```json
{
  "name": "Gap up",
  "explanation": "Premarket movers",
  "definition": {
    "columns": ["name", "premarket_change", "close"],
    "filters": [{"left": "premarket_change", "operation": "greater", "right": 5}],
    "order_by": "premarket_change",
    "ascending": false,
    "limit": 30,
    "market": "america"
  }
}
```""",
        },
    ]

    captured: dict = {}

    async def fake_stream_run(**kwargs):
        captured.update(kwargs)
        for event in events:
            yield event

    class FakeBridge:
        configured = True

        def stream_run(self, **kwargs):
            return fake_stream_run(**kwargs)

    monkeypatch.setattr(mod, "build_screener_generate_prompt", lambda text: f"PROMPT:{text}")

    # Patch the import target used inside generate_screener_from_text
    import api.cursor_sdk_bridge as bridge_mod

    monkeypatch.setattr(bridge_mod, "cursor_sdk_bridge", FakeBridge())
    monkeypatch.setattr(bridge_mod, "load_cursor_api_env", lambda: True)

    result = asyncio.run(mod.generate_screener_from_text("premarket > 5%"))
    assert result["name"] == "Gap up"
    assert captured["session_name"] == "screener-ai"
    assert captured["mcp_servers"] is None
    assert captured["prompt"].startswith("PROMPT:")
    assert "definition" in result
    assert result["definition"]["filters"][0]["left"] == "premarket_change"
