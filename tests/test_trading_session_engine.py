import asyncio

from control_plane.trading_session_explore import build_explore_kickoff_prompt, parse_top_stock_pick
import pytest

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


def test_store_delete_session(store):
    session = store.create_session(max_capital=1000, profit_target=100)
    store.append_event(session["id"], "session_created", {"ok": True})
    store.append_state_transition(session["id"], from_state=None, to_state="explore", reason="init")

    assert store.delete_session(session["id"]) is True
    assert store.get_session(session["id"]) is None
    assert store.list_events(session["id"]) == []
    assert store.list_state_log(session["id"]) == []
    assert store.delete_session(session["id"]) is False


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
    assert "max_capital=$1,000" in prompt
    assert "profit_target=$100" in prompt
    assert "get_historical_candles" in prompt
    assert "DOUBLE-CHECK" in prompt


def _patch_resolve(monkeypatch):
    from control_plane.instrument_resolve import ResolvedInstrument

    async def fake_resolve(*_args, **_kwargs):
        return ResolvedInstrument(
            symbol="NVDA",
            token="1111",
            exchange="ETORO",
            tradingsymbol="NVDA",
        )

    monkeypatch.setattr("control_plane.trading_session_handlers.resolve_instrument", fake_resolve)


def _noop_schedulers(monkeypatch):
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_research_agent", lambda *_: None)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_strategy_agent", lambda *_: None)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_monitor_loop", lambda *_: None)


def test_create_with_symbol_resolves_to_research(store, monkeypatch):
    _patch_resolve(monkeypatch)
    _noop_schedulers(monkeypatch)
    engine = TradingSessionEngine(store)

    async def _run():
        return await engine.create_session({
            "symbol": "NVDA",
            "broker": "etoro",
            "account_env": "demo",
            "max_capital": 5000,
            "profit_target": 500,
        })

    detail = asyncio.run(_run())
    assert detail["state"] == "research"
    assert detail["symbol"] == "NVDA"
    assert detail["token"] == "1111"


def test_create_without_symbol_schedules_agent(store, monkeypatch):
    scheduled: list[str] = []

    def fake_schedule(session_id, _store, _engine):
        scheduled.append(session_id)

    monkeypatch.setattr("control_plane.trading_session_engine.schedule_explore_agent", fake_schedule)
    engine = TradingSessionEngine(store)

    async def _run():
        return await engine.create_session({
            "broker": "etoro",
            "max_capital": 5000,
            "profit_target": 500,
        })

    detail = asyncio.run(_run())
    assert detail["state"] == "explore"
    assert len(scheduled) == 1


def test_stop_session(store, monkeypatch):
    _patch_resolve(monkeypatch)
    _noop_schedulers(monkeypatch)
    engine = TradingSessionEngine(store)

    async def _run():
        detail = await engine.create_session({"symbol": "X", "broker": "etoro"})
        assert detail["state"] == "research"
        session = store.create_session(symbol="Y", broker="etoro")
        store.update_session(session["id"], {"state": "explore", "stopped_reason": None})
        return await engine.stop_session(session["id"], "manual stop")

    stopped = asyncio.run(_run())
    assert stopped["state"] == "stopped"
    assert stopped["stopped_reason"] == "manual stop"


def test_agent_explore_auto_pick(store, monkeypatch):
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
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_research_agent", lambda *_: None)

    engine = TradingSessionEngine(store)
    session = store.create_session(broker="etoro", max_capital=5000, profit_target=500)
    store.update_session(session["id"], {"state": "explore"})

    from control_plane.trading_session_explore import run_agent_explore

    async def _run():
        await run_agent_explore(session["id"], store, engine)

    asyncio.run(_run())

    updated = store.get_session(session["id"])
    assert updated["state"] == "research"
    assert updated["symbol"] == "TSLA"
    events = store.list_events(session["id"])
    types_seen = [e["event_type"] for e in events]
    assert "agent_tool_call" in types_seen
    assert "agent_a2ui_surface" in types_seen
    assert "top_pick_selected" in types_seen


def test_research_to_strategy_transition(store, monkeypatch):
    import sys
    import types

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "done", "text": '```json\n{"a2ui":{"component":"TradeDecision","props":{"text":"Bullish","confidence_pct":70}}}\n```'}

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_strategy_agent", lambda *_: None)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="NVDA", token="1111", exchange="ETORO", max_capital=5000, profit_target=500,
    )
    store.update_session(session["id"], {"state": "research"})

    from control_plane.trading_session_research import run_agent_research

    async def _run():
        await run_agent_research(session["id"], store, engine)

    asyncio.run(_run())

    updated = store.get_session(session["id"])
    assert updated["state"] == "strategy"


def test_strategy_to_deploy_transition(store, monkeypatch):
    import sys
    import types

    strategy_text = '''
```json
{"ai_action":{"type":"strategy_suggestion","title":"NVDA","payload":{
  "symbol":"NVDA","token":"1111","exchange":"ETORO","broker":"etoro","account_env":"demo",
  "close_price":100,"long_percent":2,"short_percent":1,"max_available_capital":5000
}}}
```
'''

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "done", "text": strategy_text}

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)

    async def fake_momentum_enter(req):
        return {"status": True, "data": {"execution_id": "exec-test-1"}}

    async def fake_run_session_deploy(session_id, store, engine):
        store.append_event(session_id, "deploy_complete", {"execution_id": "exec-test-1"})
        await engine.transition_session(
            session_id,
            to_state="monitor",
            reason="Trade deployed",
            patch={"engine_id": "exec-test-1"},
        )

    monkeypatch.setattr("control_plane.trading_session_deploy.run_session_deploy", fake_run_session_deploy)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_monitor_loop", lambda *_: None)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="NVDA", token="1111", exchange="ETORO", max_capital=5000, profit_target=500,
    )
    store.update_session(session["id"], {"state": "strategy"})

    from control_plane.trading_session_strategy import run_agent_strategy

    async def _run():
        await run_agent_strategy(session["id"], store, engine)

    asyncio.run(_run())

    updated = store.get_session(session["id"])
    assert updated["state"] == "monitor"
    assert updated["engine_id"] == "exec-test-1"


def test_monitor_trade_complete_stops_session(store, monkeypatch):
    import sys
    import types

    complete_text = '''
```json
{"ai_action":{"type":"trade_complete","title":"Done","payload":{"symbol":"NVDA","pnl":600,"outcome":"profit"}}}
```
'''

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "done", "text": complete_text}

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)
    async def fake_collect(_session):
        return {}

    monkeypatch.setattr("control_plane.trading_session_monitor._collect_monitor_context", fake_collect)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="NVDA", token="1111", max_capital=5000, profit_target=500,
    )
    store.update_session(session["id"], {
        "state": "monitor",
        "engine_id": "exec-test-1",
        "profit_target": 500,
    })

    from control_plane.trading_session_monitor import run_monitor_batch

    async def _run():
        return await run_monitor_batch(session["id"], store, engine)

    ended = asyncio.run(_run())
    assert ended is True

    updated = store.get_session(session["id"])
    assert updated["state"] == "stopped"
    assert updated["total_pnl"] == 600
