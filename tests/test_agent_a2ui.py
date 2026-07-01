from api.a2ui_bridge import (
    collapse_markdown_prose,
    component_to_surface,
    derive_agent_thread_title_from_text,
    expand_agent_text_to_surfaces,
    extract_a2ui_blocks,
    expand_text_to_surfaces,
    strategy_setup_surface,
    text_surface,
    trade_decision_from_tool,
)
from control_plane.agent_thread_state import (
    focus_from_action,
    sync_focus_from_actions,
    UI_PHASE_TRADING,
    _latest_strategy_action,
)


def test_extract_a2ui_blocks_top_stock_picks_nested():
    text = """Intro
```a2ui
{"a2ui":{"component":"TopStockPicks","props":{"picks":[{"symbol":"LRCX","name":"Lam Research"},{"symbol":"KLAC","name":"KLA"},{"symbol":"NVDA","name":"NVIDIA"}]}}}
```
"""
    blocks = extract_a2ui_blocks(text)
    assert len(blocks) == 1
    assert blocks[0]["component"] == "TopStockPicks"
    assert len(blocks[0]["props"]["picks"]) == 3


def test_expand_agent_text_to_surfaces_strips_fence_and_sources():
    text = """LRCX is Lam Research.
```json
{"a2ui":{"component":"TopStockPicks","props":{"picks":[{"symbol":"LRCX","name":"Lam"}]}}}
```
**Sources:**
- [Yahoo](https://example.com)
"""
    surfaces = list(expand_agent_text_to_surfaces(text))
    components = [s["components"][0]["component"] for s in surfaces]
    assert "TopStockPicks" in components
    text_surfaces = [s for s in surfaces if s["components"][0]["component"] == "Text"]
    assert len(text_surfaces) == 1
    assert "LRCX" in text_surfaces[0]["components"][0]["props"]["text"]
    assert "```" not in text_surfaces[0]["components"][0]["props"]["text"]
    assert "Yahoo" not in text_surfaces[0]["components"][0]["props"]["text"]


def test_extract_a2ui_blocks():
    text = 'Hello\n```json\n{"a2ui":{"component":"TradeDecision","props":{"text":"Watching INFY","symbol":"INFY"}}}\n```'
    blocks = extract_a2ui_blocks(text)
    assert len(blocks) == 1
    assert blocks[0]["component"] == "TradeDecision"
    assert blocks[0]["props"]["symbol"] == "INFY"


def test_collapse_markdown_prose():
    raw = "### Deep dive\n\n**NSE** plan with `levels`"
    assert collapse_markdown_prose(raw) == "Deep dive NSE plan with levels"


def test_expand_agent_text_to_surfaces_ai_action():
    text = """
```json
{"ai_action":{"type":"strategy_suggestion","title":"RPOWER","payload":{"symbol":"RPOWER-EQ","broker":"angel","max_available_capital":1000}}}
```
"""
    surfaces = list(expand_agent_text_to_surfaces(text))
    assert any(s["components"][0]["component"] == "StrategySetupForm" for s in surfaces)


def test_expand_agent_text_to_surfaces_ai_summary():
    text = """
```json
{"ai_summary":{"highlights":["Volume"],"lowlights":[],"cautions":["Risk"]}}
```
"""
    surfaces = list(expand_agent_text_to_surfaces(text))
    assert any(s["components"][0]["component"] == "InsightCards" for s in surfaces)


def test_derive_agent_thread_title_from_trade_decision():
    text = '```json\n{"a2ui":{"component":"TradeDecision","props":{"symbol":"RPOWER","text":"pick"}}}\n```'
    session = {"metadata": {"broker": "angel"}}
    assert derive_agent_thread_title_from_text(text, session) == "RPOWER · Angel"


def test_expand_text_to_surfaces_plain_text():
    surfaces = list(expand_text_to_surfaces("Plain reply"))
    assert len(surfaces) == 1
    assert surfaces[0]["components"][0]["component"] == "Text"


def test_trade_decision_from_create_strategy_tool():
    surface = trade_decision_from_tool(
        {
            "tool_name": "create_strategy",
            "content": '{"symbol":"INFY-EQ","token":"1594"}',
            "tool_status": "completed",
        }
    )
    assert surface is not None
    assert surface["components"][0]["component"] == "TradeDecision"


def test_focus_from_action_and_sync_ui_phase(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))
    monkeypatch.setattr("control_plane.engine_registry.DB_PATH", str(db_path))

    from control_plane.ai_research_store import AiResearchStore

    store = AiResearchStore()
    session = store.create_session(
        title="Agent thread",
        interaction_mode="execute",
        metadata={"product": "agent_mode", "ui_phase": "chat"},
    )
    session_id = session["session_id"]
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "AMD chip momentum",
            "status": "saved",
            "payload": {
                "symbol": "AMD",
                "token": "1111",
                "exchange": "ETORO",
                "broker": "etoro",
                "close_price": 580.91,
            },
        },
    )
    store.upsert_action(
        session_id,
        {
            "type": "strategy_suggestion",
            "title": "NVDA deploy",
            "status": "running",
            "payload": {
                "symbol": "NVDA",
                "token": "2222",
                "exchange": "ETORO",
                "broker": "etoro",
                "close_price": 200.09,
                "execution_id": "etoro-nvda-strategy-default",
            },
        },
    )

    session = store.get_session(session_id)
    latest = _latest_strategy_action(session)
    assert latest is not None
    assert latest["payload"]["symbol"] == "NVDA"

    synced = sync_focus_from_actions(session)
    assert synced["metadata"]["ui_phase"] == UI_PHASE_TRADING
    assert synced["metadata"]["focus"]["symbol"] == "NVDA"
    assert synced["metadata"]["focus"]["close_price"] == 200.09


def test_component_to_surface_shape():
    surface = component_to_surface("Text", {"text": "Hello"})
    assert surface["type"] == "a2ui_surface"
    assert surface["role"] == "agent"
    assert surface["components"][0]["props"]["text"] == "Hello"

    plain = text_surface("Hi")
    assert plain["components"][0]["component"] == "Text"


def test_strategy_setup_surface():
    surface = strategy_setup_surface({
        "title": "INFY",
        "payload": {"symbol": "INFY-EQ", "max_available_capital": 5000},
    })
    props = surface["components"][0]["props"]
    assert props["symbol"] == "INFY-EQ"
    assert props["max_available_capital"] == 5000
