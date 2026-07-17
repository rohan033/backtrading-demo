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
    prompt = build_explore_kickoff_prompt(session, store, session["id"])
    assert "max_capital=$1,000" in prompt
    assert "profit_target=$100" in prompt
    assert "get_historical_candles" in prompt
    assert "DOUBLE-CHECK" in prompt
    assert "broker=etoro" in prompt
    assert "NEVER pass exchange=NSE" in prompt
    assert "search_scrip" in prompt


def test_broker_block_angel(store):
    from control_plane.trading_session_prompts import trading_session_broker_block

    session = store.create_session(broker="angel", account_env="live")
    block = trading_session_broker_block(session)
    assert "Angel One" in block
    assert "exchange=NSE" in block
    assert "eToro" in block


def test_infer_resume_state_from_strategy_failure(store):
    from control_plane.trading_session_prompts import infer_resume_state

    session = store.create_session(max_capital=5000, profit_target=500, symbol="TSLA", token="1137")
    store.update_session(session["id"], {
        "state": "stopped",
        "stopped_reason": "Strategy agent did not return setup parameters",
    })
    session = store.get_session(session["id"])
    log = store.list_state_log(session["id"])
    assert infer_resume_state(session, log) == "strategy"


def test_dispatch_prompt_resumes_stopped_session(store, monkeypatch):
    from control_plane.trading_session_engine import TradingSessionEngine

    session = store.create_session(max_capital=5000, profit_target=500, symbol="TSLA", token="1137")
    store.update_session(session["id"], {
        "state": "stopped",
        "stopped_reason": "Strategy agent did not return setup parameters",
    })
    store.append_state_transition(
        session["id"],
        from_state="strategy",
        to_state="stopped",
        reason="Strategy agent did not return setup parameters",
    )

    async def fake_prepare(session_id, store):
        s = store.get_session(session_id)
        config = {
            "symbol": s.get("symbol"),
            "token": s.get("token"),
            "exchange": "ETORO",
            "broker": "etoro",
            "account_env": "demo",
            "close_price": 420.0,
            "long_percent": 2.0,
            "short_percent": 1.0,
            "max_available_capital": 5000,
        }
        store.append_event(session_id, "strategy_config", {"config": config})
        return config

    async def noop_deploy(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        "control_plane.trading_session_strategy.prepare_session_strategy_config",
        fake_prepare,
    )
    monkeypatch.setattr("control_plane.trading_session_deploy.run_session_deploy", noop_deploy)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_research_agent", lambda *_: None)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_explore_agent", lambda *_: None)

    engine = TradingSessionEngine(store)

    async def run() -> None:
        detail = await engine.dispatch_prompt(session["id"], "Retry with 5% target and 2% stop")
        assert detail is not None
        assert detail["state"] == "deploy"
        assert detail.get("stopped_reason") is None
        events = store.list_events(session["id"], since_id=0)
        assert any(e["event_type"] == "user_instruction" for e in events)
        assert any(e["event_type"] == "strategy_config" for e in events)

    asyncio.run(run())


def test_parse_strategy_suggestion_from_setup_form():
    from control_plane.trading_session_agent_common import parse_strategy_suggestion

    text = '''
```json
{"a2ui":{"component":"StrategySetupForm","props":{
  "symbol":"TSLA","token":"1137","exchange":"ETORO","close_price":417.95,
  "long_percent":10,"short_percent":2,"initial_threshold":0.2,"max_available_capital":5000
}}}
```
'''
    config = parse_strategy_suggestion(text)
    assert config is not None
    assert config["symbol"] == "TSLA"
    assert config["close_price"] == 417.95
    assert config["long_percent"] == 10


def test_parse_strategy_suggestion_from_summary():
    from control_plane.trading_session_agent_common import parse_strategy_suggestion

    text = '''
```json
{"a2ui":{"component":"StrategySummary","props":{
  "symbol":"AMD","entry_price":524.0,"long_percent":2,"short_percent":1,
  "capital":5000,"status":"pending","broker":"etoro","account_env":"demo"
}}}
```
'''
    config = parse_strategy_suggestion(text)
    assert config is not None
    assert config["symbol"] == "AMD"
    assert config["close_price"] == 524.0
    assert config["max_available_capital"] == 5000


def test_parse_strategy_summary_without_symbol_uses_session():
    from control_plane.trading_session_agent_common import parse_strategy_suggestion

    session = {"symbol": "META", "token": "1111"}
    text = '''
```json
{"a2ui":{"component":"StrategySummary","props":{
  "entry_price":612.42,"long_percent":2,"short_percent":1,"capital":5000,"status":"auto-deploying"
}}}
```
'''
    config = parse_strategy_suggestion(text, session)
    assert config is not None
    assert config["symbol"] == "META"
    assert config["close_price"] == 612.42


def test_parse_strategy_from_surface_events_fallback(store):
    from control_plane.trading_session_agent_common import (
        parse_strategy_from_surface_events,
        parse_strategy_suggestion,
    )

    session = store.create_session(max_capital=5000, profit_target=500, symbol="AMD", token="1832")
    started = store.append_event(session["id"], "agent_strategy_started", {"state": "strategy"})
    since_id = started["id"]
    store.append_event(
        session["id"],
        "agent_a2ui_surface",
        {
            "type": "a2ui_surface",
            "messageId": "test-summary",
            "role": "agent",
            "components": [{
                "id": "root",
                "component": "StrategySummary",
                "props": {
                    "symbol": "AMD",
                    "entry_price": 524.0,
                    "long_percent": 2,
                    "short_percent": 1,
                    "capital": 5000,
                    "broker": "etoro",
                    "account_env": "demo",
                },
            }],
        },
    )

    assert parse_strategy_suggestion("no fences here") is None
    row = store.get_session(session["id"])
    config = parse_strategy_from_surface_events(store, session["id"], since_id=since_id, session=row)
    assert config is not None
    assert config["symbol"] == "AMD"
    assert config["close_price"] == 524.0


def test_parse_strategy_suggestion_from_autonomous_entry():
    from control_plane.trading_session_agent_common import parse_strategy_suggestion

    text = '''
```json
{"ai_action":{"type":"autonomous_entry","title":"TSLA momentum","payload":{
  "symbol":"TSLA","token":"1137","exchange":"ETORO","broker":"etoro","account_env":"demo",
  "close_price":417.95,"long_percent":5,"short_percent":2,"max_available_capital":5000,"confidence_pct":72
}}}
```
'''
    config = parse_strategy_suggestion(text)
    assert config is not None
    assert config["symbol"] == "TSLA"
    assert config["close_price"] == 417.95
    assert config["long_percent"] == 5


def test_explore_prompt_includes_session_context(store):
    session = store.create_session(max_capital=1000, profit_target=100, broker="etoro")
    prompt = build_explore_kickoff_prompt(session, store, session["id"])
    assert f"session_id={session['id']}" in prompt
    assert "TRADING SESSION CONTEXT" in prompt


def test_resolve_strategy_from_trade_decision(store, monkeypatch):
    from control_plane.trading_session_agent_common import resolve_strategy_config

    session = store.create_session(
        max_capital=5000,
        profit_target=100,
        symbol="META",
        token="1111",
        broker="etoro",
        account_env="demo",
    )
    started = store.append_event(session["id"], "agent_strategy_started", {"state": "strategy"})
    text = '''
```json
{"a2ui":{"component":"TradeDecision","props":{"text":"Bullish","confidence_pct":67,"symbol":"META"}}}
```
'''
    async def fake_candles(**_kwargs):
        return [{"close": 612.15}]

    monkeypatch.setattr(
        "brokers.etoro.candles.aget_historical_candles",
        fake_candles,
    )

    async def run():
        row = store.get_session(session["id"])
        return await resolve_strategy_config(
            session=row,
            assistant_text=text,
            store=store,
            session_id=session["id"],
            since_id=started["id"],
        )

    config = asyncio.run(run())
    assert config is not None
    assert config["symbol"] == "META"
    assert config["close_price"] == 612.15
    assert config.get("synthesized") is True


def test_autonomous_session_surface_converts_setup_form():
    from control_plane.trading_session_agent_common import _autonomous_session_surface

    surface = {
        "type": "a2ui_surface",
        "messageId": "m1",
        "role": "agent",
        "components": [{
            "id": "r1",
            "component": "StrategySetupForm",
            "props": {
                "symbol": "AMD",
                "close_price": 528.75,
                "long_percent": 2,
                "short_percent": 1,
                "max_available_capital": 5000,
            },
        }],
    }
    out = _autonomous_session_surface(surface)
    assert out is not None
    assert out["components"][0]["component"] == "StrategySummary"
    assert out["components"][0]["props"]["status"] == "auto-deploying"
    assert out["components"][0]["props"]["entry_price"] == 528.75


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


def test_explore_deterministic_fallback_when_agent_returns_no_picks(store, monkeypatch):
    import sys
    import types

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "error", "phase": "guardrail", "message": "blocked tool"}
        return

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_research_agent", lambda *_: None)

    async def fake_deterministic_picks(_session):
        return [
            {"symbol": "NVDA", "name": "NVIDIA", "token": "1111", "exchange": "ETORO", "recommendation": "fallback"},
        ]

    monkeypatch.setattr(
        "control_plane.trading_session_explore.deterministic_explore_picks",
        fake_deterministic_picks,
    )

    engine = TradingSessionEngine(store)
    session = store.create_session(broker="etoro", max_capital=5000, profit_target=500)
    store.update_session(session["id"], {"state": "explore"})

    from control_plane.trading_session_explore import run_agent_explore

    asyncio.run(run_agent_explore(session["id"], store, engine))

    updated = store.get_session(session["id"])
    assert updated["state"] == "research"
    assert updated["symbol"] == "NVDA"
    event_types = [e["event_type"] for e in store.list_events(session["id"])]
    assert "explore_deterministic_fallback" in event_types


def test_research_failure_still_advances_to_strategy(store, monkeypatch):
    import sys
    import types

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        raise RuntimeError("agent unavailable")

    async def noop_deploy(*_args, **_kwargs):
        return None

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)
    monkeypatch.setattr("control_plane.trading_session_deploy.run_session_deploy", noop_deploy)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="NVDA", token="1111", exchange="ETORO", max_capital=5000, profit_target=500,
    )
    store.update_session(session["id"], {"state": "research"})

    from control_plane.trading_session_research import run_agent_research

    asyncio.run(run_agent_research(session["id"], store, engine))

    updated = store.get_session(session["id"])
    assert updated["state"] == "deploy"


def test_research_to_strategy_transition(store, monkeypatch):
    import sys
    import types

    async def fake_stream(*_args, **_kwargs):
        yield {"type": "start"}
        yield {"type": "done", "text": '```json\n{"a2ui":{"component":"TradeDecision","props":{"text":"Bullish","confidence_pct":70}}}\n```'}

    async def noop_deploy(*_args, **_kwargs):
        return None

    fake_agent_mod = types.ModuleType("api.cursor_agent")
    fake_agent_mod.cursor_agent_service = type("Svc", (), {"stream_chat": staticmethod(fake_stream)})()
    monkeypatch.setitem(sys.modules, "api.cursor_agent", fake_agent_mod)
    monkeypatch.setattr("control_plane.trading_session_deploy.run_session_deploy", noop_deploy)

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
    assert updated["state"] == "deploy"


def test_strategy_to_deploy_transition(store, monkeypatch):
    async def fake_prepare(session_id, store):
        session = store.get_session(session_id)
        config = {
            "symbol": session.get("symbol"),
            "token": session.get("token"),
            "exchange": session.get("exchange") or "ETORO",
            "broker": session.get("broker") or "etoro",
            "account_env": session.get("account_env") or "demo",
            "close_price": 100.0,
            "long_percent": 2.0,
            "short_percent": 1.0,
            "initial_threshold": 0.2,
            "max_available_capital": session.get("max_capital") or 5000,
        }
        store.append_event(session_id, "strategy_config", {"config": config})
        return config

    monkeypatch.setattr(
        "control_plane.trading_session_strategy.prepare_session_strategy_config",
        fake_prepare,
    )

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

    from control_plane.trading_session_strategy import run_deterministic_strategy

    async def _run():
        await run_deterministic_strategy(session["id"], store, engine)

    asyncio.run(_run())

    updated = store.get_session(session["id"])
    assert updated["state"] == "monitor"
    assert updated["engine_id"] == "exec-test-1"


def test_strategy_on_enter_transitions_to_deploy(store, monkeypatch):
    async def fake_prepare(session_id, store):
        session = store.get_session(session_id)
        config = {
            "symbol": session.get("symbol"),
            "token": session.get("token"),
            "exchange": "ETORO",
            "broker": "etoro",
            "account_env": "demo",
            "close_price": 140.0,
            "long_percent": 2.0,
            "short_percent": 1.0,
            "max_available_capital": 5000,
        }
        store.append_event(session_id, "strategy_config", {"config": config})
        return config

    async def noop_deploy(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        "control_plane.trading_session_strategy.prepare_session_strategy_config",
        fake_prepare,
    )
    monkeypatch.setattr("control_plane.trading_session_deploy.run_session_deploy", noop_deploy)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_research_agent", lambda *_: None)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_explore_agent", lambda *_: None)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="XOM", token="9999", exchange="ETORO", max_capital=5000, profit_target=100,
    )
    store.update_session(session["id"], {"state": "strategy"})

    async def _run():
        await engine.transition_session(session["id"], to_state="strategy", reason="test")

    asyncio.run(_run())

    updated = store.get_session(session["id"])
    assert updated["state"] == "deploy"


def test_deploy_builds_config_when_event_missing(store, monkeypatch):
    async def fake_prepare(session_id, store):
        session = store.get_session(session_id)
        return {
            "symbol": session.get("symbol"),
            "token": session.get("token"),
            "exchange": "ETORO",
            "broker": "etoro",
            "account_env": "demo",
            "close_price": 140.81,
            "long_percent": 2.0,
            "short_percent": 1.0,
            "max_available_capital": 5000,
        }

    monkeypatch.setattr(
        "control_plane.trading_session_strategy.prepare_session_strategy_config",
        fake_prepare,
    )

    async def fake_momentum_enter(_req):
        return {"data": {"execution_id": "exec-xom-1"}}

    monkeypatch.setattr("api.server.momentum_enter", fake_momentum_enter)
    monkeypatch.setattr("control_plane.trading_session_engine.schedule_monitor_loop", lambda *_: None)

    engine = TradingSessionEngine(store)
    session = store.create_session(
        broker="etoro", symbol="XOM", token="9999", exchange="ETORO", max_capital=5000, profit_target=100,
    )
    store.update_session(session["id"], {"state": "deploy"})

    from control_plane.trading_session_deploy import run_session_deploy

    asyncio.run(run_session_deploy(session["id"], store, engine))

    updated = store.get_session(session["id"])
    assert updated["state"] == "monitor"
    assert updated["engine_id"] == "exec-xom-1"


def test_infer_resume_state_deploy_config_failure(store):
    from control_plane.trading_session_prompts import infer_resume_state

    session = store.create_session(symbol="XOM", token="9999")
    store.update_session(session["id"], {
        "state": "stopped",
        "stopped_reason": "Deploy failed: no strategy configuration",
    })
    assert infer_resume_state(store.get_session(session["id"]), []) == "strategy"


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
