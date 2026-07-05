import asyncio

import pytest

from control_plane.trading_session_explore import build_explore_kickoff_prompt, parse_top_stock_pick
from control_plane.trading_session_engine import TradingSessionEngine
from control_plane.trading_session_store import TradingSessionStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.trading_session_store.DB_PATH", str(db_path))
    return TradingSessionStore(str(db_path))


def test_store_crud_and_events(store):
    session = store.create_session(
        max_capital=5000,
        profit_target=500,
        symbol="NVDA",
        broker="etoro",
    )
    assert session["state"] == "explore"
    assert session["symbol"] == "NVDA"

    event = store.append_event(session["id"], "session_created", {"ok": True})
    assert event["id"] >= 1

    events = store.list_events(session["id"], since_id=0)
    assert len(events) == 1

    more = store.list_events(session["id"], since_id=event["id"])
    assert more == []

    store.append_state_transition(session["id"], from_state=None, to_state="explore", reason="init")
    log = store.list_state_log(session["id"])
    assert len(log) == 1


def test_parse_top_stock_picks():
    text = '''
```json
{"a2ui":{"component":"TopStockPicks","props":{"picks":[
{"symbol":"NVDA","name":"NVIDIA","token":"1111","exchange":"ETORO","recommendation":"Best pick"},
{"symbol":"AMD","name":"AMD","token":"1832","exchange":"ETORO","recommendation":"Runner up"}
]}}}
```
'''
    from control_plane.trading_session_explore import parse_top_stock_picks
    picks = parse_top_stock_picks(text)
    assert len(picks) == 2
    assert picks[0]["symbol"] == "NVDA"
    assert picks[1]["symbol"] == "AMD"


def test_parse_top_stock_pick():
    text = '''
```json
{"a2ui":{"component":"TopStockPicks","props":{"picks":[{"symbol":"NVDA","name":"NVIDIA","token":"1111","exchange":"ETORO","recommendation":"Best pick"}]}}}
```
'''
    pick = parse_top_stock_pick(text)
    assert pick is not None
    assert pick["symbol"] == "NVDA"
    assert pick["token"] == "1111"


def test_build_explore_prompt_includes_goals(store):
    session = store.create_session(max_capital=1000, profit_target=100, broker="etoro")
    prompt = build_explore_kickoff_prompt(session)
    assert "1000" in prompt
    assert "100" in prompt
    assert "EXPLORE" in prompt


@pytest.mark.asyncio
async def test_create_with_symbol_resolves_and_stops(store, monkeypatch):
    from control_plane.instrument_resolve import ResolvedInstrument

    async def fake_resolve(*_args, **_kwargs):
        return ResolvedInstrument(
            symbol="NVDA",
            token="1111",
            exchange="ETORO",
            tradingsymbol="NVDA",
        )

    monkeypatch.setattr("control_plane.trading_session_handlers.resolve_instrument", fake_resolve)
    engine = TradingSessionEngine(store)
    detail = await engine.create_session({
        "symbol": "NVDA",
        "broker": "etoro",
        "account_env": "demo",
        "max_capital": 5000,
        "profit_target": 500,
    })
    assert detail["state"] == "stopped"
    assert detail["symbol"] == "NVDA"
    assert detail["token"] == "1111"


@pytest.mark.asyncio
async def test_create_without_symbol_schedules_agent(store, monkeypatch):
    scheduled: list[str] = []

    def fake_schedule(session_id, _store, _engine):
        scheduled.append(session_id)

    monkeypatch.setattr("control_plane.trading_session_engine.schedule_explore_agent", fake_schedule)
    engine = TradingSessionEngine(store)
    detail = await engine.create_session({
        "broker": "etoro",
        "max_capital": 5000,
        "profit_target": 500,
    })
    assert detail["state"] == "explore"
    assert len(scheduled) == 1


@pytest.mark.asyncio
async def test_stop_session(store, monkeypatch):
    async def fake_resolve(*_args, **_kwargs):
        from control_plane.instrument_resolve import ResolvedInstrument
        return ResolvedInstrument(symbol="X", token="1", exchange="ETORO", tradingsymbol="X")

    monkeypatch.setattr("control_plane.trading_session_handlers.resolve_instrument", fake_resolve)
    engine = TradingSessionEngine(store)
    detail = await engine.create_session({"symbol": "X", "broker": "etoro"})
    assert detail["state"] == "stopped"

    session = store.create_session(symbol="Y", broker="etoro")
    store.update_session(session["id"], {"state": "explore", "stopped_reason": None})
    stopped = await engine.stop_session(session["id"], "manual stop")
    assert stopped["state"] == "stopped"
    assert stopped["stopped_reason"] == "manual stop"


@pytest.mark.asyncio
async def test_agent_explore_auto_pick(store, monkeypatch):
    import sys
    import types

    pick_text = '''
```json
{"a2ui":{"component":"TopStockPicks","props":{"picks":[{"symbol":"TSLA","token":"1137","exchange":"ETORO","recommendation":"Momentum"}]}}}
```
'''

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "tool_call", "tool_name": "search_instruments", "tool_status": "completed", "content": "NVDA"}
        yield {"type": "done", "text": pick_text}

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)

    engine = TradingSessionEngine(store)
    session = store.create_session(broker="etoro", max_capital=5000, profit_target=500)
    store.update_session(session["id"], {"state": "explore"})

    from control_plane.trading_session_explore import run_agent_explore
    await run_agent_explore(session["id"], store, engine)

    updated = store.get_session(session["id"])
    assert updated["state"] == "stopped"
    assert updated["symbol"] == "TSLA"
    events = store.list_events(session["id"])
    types = [e["event_type"] for e in events]
    assert "agent_tool_call" in types
    assert "agent_a2ui_surface" in types
    assert "top_pick_selected" in types
