import sys
import os
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
import asyncio
import json
import uuid

from client import TotpClient
from strategy import Strategy
from backtesting import Backtesting
from api.manual_robo_routes import router as manual_robo_router
from control_plane.engine_registry import EngineRegistry
from control_plane.engine_process_manager import EngineProcessManager, REPO_ROOT
from event.db_event_consumer import DbEventWriter

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("backtrading")

app = FastAPI(title="Backtrading API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(manual_robo_router)

IST = timezone(timedelta(hours=5, minutes=30))
TRADE_FEE = 25  # ₹25 per buy-sell round trip
engine_registry = EngineRegistry()
engine_registry.ensure_default_engine()
engine_process_manager = EngineProcessManager(engine_registry)
_engine_sweeper_task: Optional[asyncio.Task] = None
_live_events_db: Optional[DbEventWriter] = None


def get_live_events_db() -> DbEventWriter:
    global _live_events_db
    if _live_events_db is None:
        db_path = os.getenv("LIVE_EVENTS_DB") or str(REPO_ROOT / "live_events.db")
        _live_events_db = DbEventWriter(db_path=db_path)
    return _live_events_db

# ── Global client ──
_client: Optional[TotpClient] = None
_control_portfolio_cache: dict[str, tuple[list, float]] = {}
PORTFOLIO_CACHE_TTL = int(os.getenv("PORTFOLIO_CACHE_TTL", "300"))  # seconds


def _portfolio_cache_key(broker: str, account_env: str) -> str:
    return f"{(broker or 'angel').lower()}:{(account_env or 'live').lower()}"


def _get_portfolio_cache_entry(broker: str, account_env: str) -> tuple[list | None, float | None, bool]:
    import time as _time

    entry = _control_portfolio_cache.get(_portfolio_cache_key(broker, account_env))
    if not entry:
        return None, None, False
    data, cached_at = entry
    return data, cached_at, (_time.time() - cached_at) < PORTFOLIO_CACHE_TTL


def _set_portfolio_cache(broker: str, account_env: str, data: list) -> None:
    import time as _time

    _control_portfolio_cache[_portfolio_cache_key(broker, account_env)] = (data, _time.time())


def get_client() -> TotpClient:
    global _client
    if _client is None:
        log.info("Initializing TotpClient and generating session...")
        _client = TotpClient(
            os.getenv("API_KEY"),
            os.getenv("CLIENT_ID"),
            os.getenv("MPIN"),
            os.getenv("TOTP_KEY"),
        )
        _client.generate_session()
        log.info("Session generated successfully")
    return _client


def tick_to_dict(tick):
    """Convert a Tick object to a dict with UNIX timestamp for lightweight-charts."""
    time_str = str(tick.time)
    try:
        dt = datetime.fromisoformat(time_str)
    except ValueError:
        dt = datetime.strptime(time_str, "%Y-%m-%dT%H:%M:%S%z")
    unix_ts = int(dt.timestamp())
    return {
        "time": unix_ts,
        "timeStr": dt.strftime("%H:%M"),
        "open": float(tick.open),
        "high": float(tick.high),
        "low": float(tick.low),
        "close": float(tick.close),
        "volume": int(tick.volume),
    }


# ── Request / Response models ──

class BacktestRequest(BaseModel):
    token: str
    symbol: str
    start_date: str  # "2026-04-17 09:15"
    end_date: str  # "2026-04-17 15:15"
    closing_start: str  # "2026-04-16 15:29"
    closing_end: str  # "2026-04-16 15:30"
    long_percent: float = 0.5
    short_percent: float = 10.0
    initial_threshold: float = 0.1
    funds: float = 110000
    base_funds: float = 100000
    interval: str = "ONE_MINUTE"


class DataPlaneEngineRequest(BaseModel):
    id: Optional[str] = None
    label: Optional[str] = None
    broker: str = "angel"
    symbol: Optional[str] = None
    token: Optional[str] = None
    strategy_name: str = "default"
    account_env: str = "live"
    host: str = "localhost"
    port: int = 8080
    api_base_url: Optional[str] = None
    ws_url: Optional[str] = None
    status: str = "unknown"
    pid: Optional[int] = None
    metadata: Optional[dict] = None


class DataPlaneEngineUpdate(BaseModel):
    label: Optional[str] = None
    broker: Optional[str] = None
    symbol: Optional[str] = None
    token: Optional[str] = None
    strategy_name: Optional[str] = None
    account_env: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    api_base_url: Optional[str] = None
    ws_url: Optional[str] = None
    status: Optional[str] = None
    pid: Optional[int] = None
    metadata: Optional[dict] = None


class ControlPlaneExecutionRequest(BaseModel):
    executor_id: Optional[str] = None
    broker: str = "angel"
    account_env: str = "live"
    strategy_name: str = "default"
    symbol: str
    token: str
    exchange: str = "NSE"
    close_price: float
    long_percent: float = 1.0
    short_percent: float = 10.0
    initial_threshold: float = 0.2
    max_available_capital: float = 100000
    use_fake_client: bool = False
    client_mode: str = "standard"


# ── Endpoints ──

@app.on_event("startup")
async def start_engine_sweeper():
    global _engine_sweeper_task
    _engine_sweeper_task = asyncio.create_task(_mark_stale_engines_loop())


@app.on_event("shutdown")
async def stop_engine_sweeper():
    if _engine_sweeper_task:
        _engine_sweeper_task.cancel()
        try:
            await _engine_sweeper_task
        except asyncio.CancelledError:
            pass

    stopped = engine_process_manager.stop_all_engines()
    if stopped:
        log.info("[CONTROL] Shutdown stopped %d live trading server(s)", len(stopped))


async def _mark_stale_engines_loop():
    timeout_seconds = int(os.getenv("LIVE_ENGINE_HEARTBEAT_TIMEOUT_SECONDS", "15"))
    while True:
        await asyncio.sleep(timeout_seconds)
        try:
            stale = engine_registry.mark_stale(timeout_seconds=timeout_seconds)
            if stale:
                log.warning("[CONTROL] Marked %d data-plane engines stale", len(stale))
        except Exception as e:
            log.error("[CONTROL] Engine stale sweeper failed: %s", e)

@app.get("/api/control/engines")
def list_data_plane_engines(status: Optional[str] = None):
    return {"status": True, "data": engine_registry.list_engines(status=status)}


@app.get("/api/control/engines/{engine_id}")
def get_data_plane_engine(engine_id: str):
    engine = engine_registry.get_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.post("/api/control/engines")
def register_data_plane_engine(req: DataPlaneEngineRequest):
    return {"status": True, "data": engine_registry.upsert_engine(req.model_dump(exclude_none=True))}


@app.patch("/api/control/engines/{engine_id}")
def update_data_plane_engine(engine_id: str, req: DataPlaneEngineUpdate):
    engine = engine_registry.update_engine(engine_id, req.model_dump(exclude_none=True))
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.post("/api/control/engines/{engine_id}/heartbeat")
def heartbeat_data_plane_engine(engine_id: str, payload: dict = Body(default_factory=dict)):
    engine = engine_registry.record_heartbeat(engine_id, payload or {"status": "running"})
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.post("/api/control/engines/{engine_id}/stop")
def stop_data_plane_engine(engine_id: str):
    engine = engine_process_manager.stop_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.delete("/api/control/engines/{engine_id}")
def delete_data_plane_engine(engine_id: str):
    if not engine_registry.delete_engine(engine_id):
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True}


@app.get("/api/control/search")
async def control_plane_search(
    q: str,
    broker: str = "angel",
    exchange: str = "NSE",
    account_env: str = "live",
    use_fake_client: bool = False,
):
    broker_name = "fake" if use_fake_client else (broker or "angel").lower()
    log.info(
        "[CONTROL_SEARCH] request broker=%s env=%s exchange=%s q=%r fake=%s",
        broker_name, account_env, exchange, q, use_fake_client,
    )
    try:
        if broker_name == "fake":
            rows = _mock_search_rows(q)
            log.info("[CONTROL_SEARCH] fake returned %d rows for %r", len(rows), q)
            return {"status": True, "data": rows}

        if broker_name == "etoro":
            from brokers.etoro.trading_client import EtoroTradingClient

            client = EtoroTradingClient(account_env=account_env)
            client.generate_session()
            instruments = await client.asearch_instruments(q)
            rows = [_etoro_instrument_to_search_row(item) for item in instruments]
            log.info(
                "[CONTROL_SEARCH] etoro returned %d rows for %r using account_env=%s",
                len(rows), q, account_env,
            )
            return {"status": True, "data": rows}

        client = get_client()
        result = client._client.searchScrip(exchange, q)
        if result and result.get("status"):
            rows = result.get("data", []) or []
            log.info("[CONTROL_SEARCH] angel returned %d rows for %r", len(rows), q)
            for item in rows[:10]:
                log.info(
                    "[CONTROL_SEARCH] row symbol=%s token=%s exchange=%s",
                    item.get("tradingsymbol"), item.get("symboltoken"), item.get("exchange"),
                )
            return {"status": True, "data": rows}

        log.warning("[CONTROL_SEARCH] angel returned no results for %r: %s", q, result)
        return {"status": False, "message": "No results found", "data": []}
    except Exception as e:
        log.error(
            "[CONTROL_SEARCH] failed broker=%s env=%s q=%r status=%s payload=%s error=%s",
            broker_name,
            account_env,
            q,
            getattr(e, "status_code", None),
            getattr(e, "payload", None),
            e,
            exc_info=True,
        )
        return {"status": False, "message": str(e), "data": []}


@app.get("/api/control/executions")
def list_controlled_executions():
    executions = []
    for engine in engine_registry.list_engines():
        metadata = engine.get("metadata") or {}
        if metadata.get("source") != "controlled_execution":
            continue
        executions.append(
            {
                "execution_id": engine["id"],
                "engine": engine,
                "executor": metadata.get("executor_payload"),
            }
        )
    return {"status": True, "data": executions}


def _controlled_execution_payload(req: ControlPlaneExecutionRequest) -> tuple[str, dict, dict]:
    executor_id = req.executor_id or _execution_id(req.broker, req.symbol, req.strategy_name)
    executor_payload = {
        "executor_id": executor_id,
        "symbol": req.symbol,
        "token": req.token,
        "exchange": req.exchange,
        "close_price": req.close_price,
        "long_percent": req.long_percent,
        "short_percent": req.short_percent,
        "initial_threshold": req.initial_threshold,
        "max_available_capital": req.max_available_capital,
    }
    broker = "fake" if req.use_fake_client else req.broker
    label = f"{req.broker}-{req.symbol}-strategy-{req.strategy_name}"
    engine_config = {
        "id": executor_id,
        "label": label,
        "broker": broker,
        "symbol": req.symbol,
        "token": req.token,
        "strategy_name": req.strategy_name,
        "account_env": req.account_env,
        "host": "localhost",
        "port": 0,
        "api_base_url": "",
        "ws_url": "",
        "status": "pending",
        "metadata": {
            "source": "controlled_execution",
            "executor_payload": executor_payload,
            "execution_config": req.model_dump(),
            "exchange": req.exchange,
            "client_mode": req.client_mode,
            "use_fake_client": req.use_fake_client,
        },
    }
    return executor_id, executor_payload, engine_config


@app.post("/api/control/executions")
def create_controlled_execution(req: ControlPlaneExecutionRequest):
    execution_id, executor_payload, engine_config = _controlled_execution_payload(req)
    try:
        engine = engine_registry.upsert_engine(engine_config)
    except Exception as e:
        log.error("[CONTROL] Failed to create execution: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    log.info("[CONTROL] Created pending execution %s for %s", execution_id, req.symbol)
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": engine,
            "executor": executor_payload,
        },
    }


@app.post("/api/control/executions/{execution_id}/start")
def start_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    metadata = engine.get("metadata") or {}
    if metadata.get("source") != "controlled_execution":
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    if engine.get("status") == "running":
        log_file = metadata.get("log_file")
        return {
            "status": True,
            "data": {
                "engine": engine,
                "executor": metadata.get("executor_payload"),
                "port": engine.get("port"),
                "api_base_url": engine.get("api_base_url"),
                "ws_url": engine.get("ws_url"),
                "log_file": log_file,
            },
        }

    if engine.get("status") == "starting":
        log_file = metadata.get("log_file")
        return {
            "status": True,
            "data": {
                "engine": engine,
                "executor": metadata.get("executor_payload"),
                "port": engine.get("port"),
                "api_base_url": engine.get("api_base_url"),
                "ws_url": engine.get("ws_url"),
                "log_file": log_file,
            },
        }

    config = metadata.get("execution_config") or {}
    executor_payload = metadata.get("executor_payload") or {}
    try:
        started = engine_process_manager.start_engine(
            {
                "id": execution_id,
                "broker": engine.get("broker") or config.get("broker") or "angel",
                "account_env": engine.get("account_env") or config.get("account_env") or "live",
                "strategy_name": engine.get("strategy_name") or config.get("strategy_name") or "default",
                "client_mode": metadata.get("client_mode") or config.get("client_mode") or "standard",
                "symbol": engine.get("symbol") or config.get("symbol"),
                "token": engine.get("token") or config.get("token"),
                "label": engine.get("label"),
                "use_fake_client": bool(metadata.get("use_fake_client") or config.get("use_fake_client")),
                "metadata": {
                    **metadata,
                    "executor_payload": executor_payload,
                },
            }
        )
    except Exception as e:
        log.error("[CONTROL] Failed to start data-plane engine %s: %s", execution_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    started_metadata = started.get("metadata") or {}
    log_file = started_metadata.get("log_file")
    log.info(
        "[CONTROL] Started execution %s on port=%s log_file=%s",
        execution_id,
        started.get("port"),
        log_file,
    )
    return {
        "status": True,
        "data": {
            "engine": started,
            "executor": executor_payload,
            "port": started.get("port"),
            "api_base_url": started.get("api_base_url"),
            "ws_url": started.get("ws_url"),
            "log_file": log_file,
        },
    }


@app.get("/api/control/executions/{execution_id}")
def get_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    metadata = engine.get("metadata") or {}
    if metadata.get("source") != "controlled_execution":
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": engine,
            "executor": metadata.get("executor_payload"),
        },
    }


@app.get("/api/control/executions/{execution_id}/duplicate-template")
def duplicate_execution_template(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    metadata = engine.get("metadata") or {}
    if metadata.get("source") != "controlled_execution":
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    config = dict(metadata.get("execution_config") or {})
    executor_payload = dict(metadata.get("executor_payload") or {})
    base_id = config.get("executor_id") or execution_id
    copy_id = f"{base_id}-copy-{uuid.uuid4().hex[:8]}"
    config["executor_id"] = copy_id
    executor_payload["executor_id"] = copy_id

    return {
        "status": True,
        "data": {
            "template": config,
            "executor": executor_payload,
            "source_execution_id": execution_id,
        },
    }


@app.post("/api/control/executions/{execution_id}/stop")
def stop_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    metadata = engine.get("metadata") or {}
    if metadata.get("source") != "controlled_execution":
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    if engine.get("pid") and engine.get("status") in {"starting", "running", "stale"}:
        stopped = engine_process_manager.stop_engine(execution_id)
    else:
        stopped = engine_registry.update_engine(
            execution_id,
            {"status": "stopped", "pid": None},
        )

    if not stopped:
        raise HTTPException(status_code=500, detail="Failed to stop execution")

    log.info("[CONTROL] Stopped execution %s", execution_id)
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": stopped,
            "executor": metadata.get("executor_payload"),
        },
    }


def _execution_id(broker: str, symbol: str, strategy_name: str) -> str:
    raw = f"{broker}-{symbol}-strategy-{strategy_name}".lower()
    return "".join(ch if ch.isalnum() else "-" for ch in raw).strip("-")


@app.get("/api/control/events")
def get_control_events(
    limit: int = 100,
    action: Optional[str] = None,
    executor_id: Optional[str] = None,
    order_id: Optional[str] = None,
):
    events = get_live_events_db().query_events(
        limit=limit,
        action=action,
        executor_id=executor_id,
        order_id=order_id,
    )
    return {"status": True, "data": events}


@app.get("/api/control/trades")
def get_control_trades(
    limit: int = 100,
    action: Optional[str] = None,
    executor_id: Optional[str] = None,
    symbol: Optional[str] = None,
):
    trades = get_live_events_db().query_trading_events(
        limit=limit,
        action=action,
        executor_id=executor_id,
        symbol=symbol,
    )
    return {"status": True, "data": trades}


@app.get("/api/control/orders")
def get_control_orders(executor_id: Optional[str] = None, limit: int = 100):
    orders = get_live_events_db().query_orders_snapshot(executor_id=executor_id, limit=limit)
    return {"status": True, "data": orders}


@app.get("/api/control/event-sessions")
def get_control_event_sessions(limit: int = 100):
    sessions = get_live_events_db().query_event_sessions(limit=limit)
    return {"status": True, "data": sessions}


@app.get("/api/control/event-sessions/{session_id}/events")
def get_control_event_session_events(session_id: str, limit: int = 300):
    db = get_live_events_db()
    events = db.query_trading_events(executor_id=session_id, limit=limit)
    if not events:
        events = db.query_events(executor_id=session_id, limit=limit)
    return {"status": True, "data": events}


def _mock_search_rows(q: str) -> list[dict]:
    mock_stocks = [
        {"tradingsymbol": "RELIANCE-EQ", "symboltoken": "2885", "exchange": "NSE"},
        {"tradingsymbol": "INFY-EQ", "symboltoken": "1594", "exchange": "NSE"},
        {"tradingsymbol": "TCS-EQ", "symboltoken": "11536", "exchange": "NSE"},
        {"tradingsymbol": "HDFCBANK-EQ", "symboltoken": "1333", "exchange": "NSE"},
        {"tradingsymbol": "BAJFINANCE-EQ", "symboltoken": "317", "exchange": "NSE"},
        {"tradingsymbol": "SBIN-EQ", "symboltoken": "3045", "exchange": "NSE"},
        {"tradingsymbol": "ICICIBANK-EQ", "symboltoken": "4963", "exchange": "NSE"},
        {"tradingsymbol": "LUPIN-EQ", "symboltoken": "10440", "exchange": "NSE"},
        {"tradingsymbol": "WIPRO-EQ", "symboltoken": "3787", "exchange": "NSE"},
        {"tradingsymbol": "TATAMOTORS-EQ", "symboltoken": "3456", "exchange": "NSE"},
    ]
    needle = q.upper()
    return [stock for stock in mock_stocks if needle in stock["tradingsymbol"].upper()]


def _etoro_instrument_to_search_row(instrument: dict) -> dict:
    instrument_id = (
        instrument.get("instrumentId")
        or instrument.get("instrumentID")
        or instrument.get("InstrumentID")
    )
    symbol = (
        instrument.get("symbolFull")
        or instrument.get("internalSymbolFull")
        or instrument.get("symbol")
        or instrument.get("displayName")
        or str(instrument_id or "")
    )
    exchange = (
        instrument.get("exchangeName")
        or instrument.get("exchange")
        or instrument.get("exchangeCode")
        or "ETORO"
    )
    return {
        "tradingsymbol": symbol,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": exchange,
        "name": instrument.get("displayName") or instrument.get("instrumentDisplayName") or symbol,
        "raw": instrument,
    }


def _etoro_position_to_portfolio_row(position: dict) -> dict:
    instrument_id = position.get("instrumentID") or position.get("instrumentId")
    symbol = (
        position.get("instrumentDisplayName")
        or position.get("InstrumentDisplayName")
        or position.get("symbol")
        or position.get("Symbol")
        or str(instrument_id or "")
    )
    units = position.get("units") or position.get("Units") or position.get("amount") or 0
    open_rate = position.get("openRate") or position.get("OpenRate") or position.get("open") or 0
    ltp = (
        position.get("currentRate")
        or position.get("CurrentRate")
        or position.get("rate")
        or position.get("openRate")
        or open_rate
    )
    return {
        "tradingsymbol": symbol,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": "ETORO",
        "quantity": str(units),
        "averageprice": str(open_rate),
        "ltp": str(ltp),
        "broker": "etoro",
    }


@app.get("/api/control/portfolio")
async def control_plane_portfolio(
    broker: str = "angel",
    account_env: str = "live",
    use_fake_client: bool = False,
    refresh: bool = False,
):
    broker_name = "fake" if use_fake_client else (broker or "angel").lower()
    log.info(
        "[CONTROL_PORTFOLIO] request broker=%s env=%s fake=%s refresh=%s",
        broker_name, account_env, use_fake_client, refresh,
    )
    cached_rows, cached_at, cache_fresh = _get_portfolio_cache_entry(broker_name, account_env)
    if cached_rows is not None and cache_fresh and not refresh:
        import time as _time
        log.info(
            "[CONTROL_PORTFOLIO] cache hit broker=%s env=%s rows=%d age=%.1fs",
            broker_name,
            account_env,
            len(cached_rows),
            _time.time() - (cached_at or 0),
        )
        return {
            "status": True,
            "broker": broker_name,
            "account_env": account_env,
            "data": cached_rows,
            "cached": True,
        }

    try:
        if broker_name == "fake":
            rows = [
                {
                    "tradingsymbol": "FAKE-EQ",
                    "symboltoken": "1",
                    "exchange": "NSE",
                    "quantity": "10",
                    "averageprice": "100",
                    "ltp": "105",
                    "broker": "fake",
                }
            ]
            _set_portfolio_cache(broker_name, account_env, rows)
            return {"status": True, "broker": broker_name, "account_env": account_env, "data": rows}

        if broker_name == "etoro":
            from brokers.etoro.trading_client import EtoroTradingClient

            client = EtoroTradingClient(account_env=account_env)
            client.generate_session()
            positions = await client.aget_positions()
            rows = [_etoro_position_to_portfolio_row(item) for item in positions]
            _set_portfolio_cache(broker_name, account_env, rows)
            log.info("[CONTROL_PORTFOLIO] etoro returned %d positions", len(rows))
            return {"status": True, "broker": broker_name, "account_env": account_env, "data": rows}

        log.info("[CONTROL_PORTFOLIO] fetching fresh angel holdings...")
        client = get_client()
        raw = client._client.holding().get("data") or []
        rows = [{**item, "broker": "angel"} for item in raw]
        _set_portfolio_cache(broker_name, account_env, rows)
        log.info("[CONTROL_PORTFOLIO] angel returned %d holdings", len(rows))
        return {"status": True, "broker": broker_name, "account_env": account_env, "data": rows}
    except Exception as e:
        log.error("[CONTROL_PORTFOLIO] failed broker=%s env=%s: %s", broker_name, account_env, e, exc_info=True)
        if cached_rows is not None:
            log.info(
                "[CONTROL_PORTFOLIO] returning stale cache broker=%s env=%s rows=%d",
                broker_name,
                account_env,
                len(cached_rows),
            )
            return {
                "status": True,
                "broker": broker_name,
                "account_env": account_env,
                "data": cached_rows,
                "cached": True,
                "stale": True,
                "message": str(e),
            }
        return {"status": False, "broker": broker_name, "account_env": account_env, "message": str(e), "data": []}


@app.get("/api/portfolio")
def get_portfolio(refresh: bool = False):
    broker_name = "angel"
    account_env = "live"
    cached_rows, cached_at, cache_fresh = _get_portfolio_cache_entry(broker_name, account_env)
    if cached_rows is not None and cache_fresh and not refresh:
        log.info("[PORTFOLIO] Serving from cache (%d holdings)", len(cached_rows))
        return {"status": True, "data": cached_rows, "cached": True}
    try:
        log.info("[PORTFOLIO] Fetching fresh holdings from API...")
        client = get_client()
        raw = client._client.holding()["data"]
        _set_portfolio_cache(broker_name, account_env, raw)
        log.info("[PORTFOLIO] Fetched %d holdings", len(raw))
        for h in raw:
            log.info("  -> %s  qty=%s  ltp=%s", h.get('tradingsymbol'), h.get('quantity'), h.get('ltp'))
        return {"status": True, "data": raw}
    except Exception as e:
        log.error("[PORTFOLIO] Error: %s", e)
        if cached_rows is not None:
            log.info("[PORTFOLIO] Returning stale cache (%d holdings)", len(cached_rows))
            return {"status": True, "data": cached_rows, "cached": True, "stale": True}
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/search")
def search_scrip(q: str, exchange: str = "NSE"):
    """Search for scrip by name using SmartApi searchScrip method"""
    try:
        log.info("[SEARCH] Query: %s, Exchange: %s", q, exchange)
        
        client = get_client()
        
        # Use SmartApi searchScrip method
        search_result = client._client.searchScrip(exchange, q)
        
        if search_result and search_result.get('status', False):
            log.info("[SEARCH] Found %d results for '%s'", len(search_result.get('data', [])), q)
            # Print all tokens in logs
            for item in search_result.get('data', []):
                log.info("[SEARCH] Token: %s -> %s", item['tradingsymbol'], item['symboltoken'])
            return {
                "status": True,
                "message": "SUCCESS",
                "data": search_result.get('data', [])
            }
        else:
            log.warning("[SEARCH] No results found for '%s'", q)
            return {
                "status": False,
                "message": "No results found",
                "data": []
            }
            
    except Exception as e:
        log.error("[SEARCH] Error searching for '%s': %s", q, e)
        return {
            "status": False,
            "message": "Search failed",
            "data": []
        }


@app.get("/api/historical/{token}")
def get_historical(
    token: str,
    start: str,
    end: str,
    interval: str = "ONE_MINUTE",
):
    try:
        log.info("[HISTORICAL] token=%s  range=%s -> %s  interval=%s", token, start, end, interval)
        client = get_client()
        ticks = client.get_historical_data(token, start, end, interval)
        candles = [tick_to_dict(t) for t in ticks]
        log.info("[HISTORICAL] Got %d candles", len(candles))
        if candles:
            log.info("  -> first: %s  last: %s", candles[0]['timeStr'], candles[-1]['timeStr'])
        return {"status": True, "data": candles}
    except Exception as e:
        log.error("[HISTORICAL] Error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    try:
        log.info("="*60)
        log.info("[BACKTEST] Starting for %s (%s)", req.symbol, req.token)
        log.info("[BACKTEST] Date range: %s -> %s", req.start_date, req.end_date)
        log.info("[BACKTEST] Closing range: %s -> %s", req.closing_start, req.closing_end)
        log.info("[BACKTEST] Strategy: init=%.2f%%  long=%.2f%%  short=%.2f%%",
                 req.initial_threshold, req.long_percent, req.short_percent)
        log.info("[BACKTEST] Capital: funds=%.0f  base=%.0f", req.funds, req.base_funds)

        client = get_client()

        # Fetch intraday candle data
        log.info("[BACKTEST] Fetching intraday data...")
        data = client.get_historical_data(
            req.token, req.start_date, req.end_date, req.interval
        )
        if not data:
            log.error("[BACKTEST] No historical data found!")
            raise HTTPException(status_code=404, detail="No historical data found")
        log.info("[BACKTEST] Got %d candles  (first=%s  last=%s)",
                 len(data), data[0].time, data[-1].time)

        # Fetch previous-day closing tick
        log.info("[BACKTEST] Fetching previous-day closing data...")
        closing_data = client.get_historical_data(
            req.token, req.closing_start, req.closing_end, req.interval
        )
        if not closing_data:
            log.error("[BACKTEST] No closing data found!")
            raise HTTPException(
                status_code=404, detail="No closing data found for previous day"
            )

        closing_tick = closing_data[0]
        log.info("[BACKTEST] Previous close: %.2f (time=%s)", closing_tick.close, closing_tick.time)

        # Build strategy & run backtest
        log.info("[BACKTEST] Running strategy...")
        strategy = Strategy(
            last_tick=closing_tick,
            long_percent=req.long_percent,
            short_percent=req.short_percent,
            initial_threshold=req.initial_threshold,
        )
        model = Backtesting(
            req.token, data, strategy, req.funds,
            base_funds=req.base_funds, symbol=req.symbol,
        )
        model.run()
        log.info("[BACKTEST] Strategy complete. %d orders generated.", len(model._orders))

        # Serialize candle data
        candles = [tick_to_dict(t) for t in data]

        # Serialize orders
        orders = []
        net = 0
        total_fees = 0
        last_order = None
        for order in model._orders:
            pnl = 0
            fee = 0
            net_amt = 0
            if order.order_type == "SELL" and last_order:
                pnl = (order.unit_price * order.quantity) - (
                    last_order.unit_price * last_order.quantity
                )
                fee = TRADE_FEE
                total_fees += fee
                pnl -= fee
                net += pnl
                net_amt = net
            last_order = order

            time_str = str(order.time) if order.time else ""
            try:
                dt = datetime.fromisoformat(time_str)
                time_display = dt.strftime("%H:%M")
                unix_ts = int(dt.timestamp())
            except (ValueError, TypeError):
                time_display = time_str
                unix_ts = 0

            orders.append({
                "time": unix_ts,
                "timeStr": time_display,
                "type": order.order_type,
                "price": float(order.unit_price),
                "qty": int(order.quantity),
                "amount": float(order.amount),
                "pnl": round(pnl, 2),
                "fee": fee,
                "net": round(net_amt, 2),
            })

        # Log each order
        for i, o in enumerate(orders):
            tag = "\033[32mBUY \033[0m" if o['type'] == 'BUY' else "\033[31mSELL\033[0m"
            log.info("  [ORDER %02d] %s  price=%.2f  qty=%d  amount=%.0f  pnl=%.0f  net=%.0f",
                     i+1, tag, o['price'], o['qty'], o['amount'], o['pnl'], o['net'])

        # Compute stats
        total_pnl = net  # already includes fees
        total_trades = len([o for o in model._orders if o.order_type == "SELL"])
        wins = len([
            i for i in range(len(orders))
            if orders[i]["type"] == "SELL" and orders[i]["pnl"] >= 0
        ])
        losses = total_trades - wins

        # Closing tick info
        prev_close_dict = tick_to_dict(closing_tick)

        stats = {
            "netPnl": round(total_pnl, 2),
            "totalFees": round(total_fees, 2),
            "returnPct": round((total_pnl / req.funds) * 100, 2) if req.funds else 0,
            "totalTrades": total_trades,
            "wins": wins,
            "losses": losses,
            "winRate": round((wins / total_trades) * 100, 1) if total_trades else 0,
            "fundsRemaining": round(model.funds, 2),
        }
        log.info("[BACKTEST] Stats: pnl=%.2f  return=%.2f%%  trades=%d  wins=%d  losses=%d  winRate=%.1f%%",
                 stats['netPnl'], stats['returnPct'], stats['totalTrades'],
                 stats['wins'], stats['losses'], stats['winRate'])
        log.info("[BACKTEST] Sending %d candles + %d orders to frontend", len(candles), len(orders))
        log.info("="*60)

        return {
            "status": True,
            "candles": candles,
            "orders": orders,
            "prevClose": prev_close_dict,
            "stats": stats,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error("[BACKTEST] FAILED: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ── WebSocket market preview for create/launch panel ──

async def _run_market_preview(ws: WebSocket, cfg: dict) -> None:
    from brokers.interfaces import Subscription, TickData

    broker = "fake" if cfg.get("use_fake_client") else (cfg.get("broker") or "angel").lower()
    token = str(cfg["token"])
    symbol = cfg["symbol"]
    exchange = cfg.get("exchange") or "NSE"
    account_env = cfg.get("account_env") or "live"
    tick_queue: asyncio.Queue = asyncio.Queue()
    feed_client = None
    subtasks: list[asyncio.Task] = []

    async def on_tick(tick) -> None:
        await tick_queue.put(tick)

    try:
        if broker == "etoro":
            from brokers.etoro.feed_client import EtoroWebsocketFeedClient

            feed_client = EtoroWebsocketFeedClient(account_env=account_env)
            feed_client.add_tick_callback(on_tick)
            await feed_client.start()
            await feed_client.subscribe(exchange, symbol, token)
        elif broker == "fake":
            seed = 100.0 + (int("".join(ch for ch in token if ch.isdigit()) or "0") % 500)

            async def fake_loop() -> None:
                import random

                price = seed
                while True:
                    price = max(1.0, price + random.uniform(-0.35, 0.35))
                    await tick_queue.put(
                        TickData(
                            symbol=symbol,
                            token=token,
                            exchange=exchange,
                            ltp=round(price, 2),
                        )
                    )
                    await asyncio.sleep(1.0)

            subtasks.append(asyncio.create_task(fake_loop()))
        else:
            from brokers.angel.trading_client import AngelOneTradingClient

            angel_client = AngelOneTradingClient()
            subscription = Subscription(exchange=exchange, symbol=symbol, token=token)

            async def angel_loop() -> None:
                while True:
                    ltps = await angel_client.aget_ltp_bulk([subscription])
                    if ltps:
                        await tick_queue.put(ltps[0])
                    await asyncio.sleep(1.0)

            subtasks.append(asyncio.create_task(angel_loop()))

        while True:
            tick = await tick_queue.get()
            await ws.send_json(
                {
                    "type": "tick",
                    "symbol": tick.symbol,
                    "token": str(tick.token),
                    "exchange": tick.exchange,
                    "ltp": float(tick.ltp),
                }
            )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.error("[CONTROL_MARKET] preview stream error broker=%s symbol=%s: %s", broker, symbol, e)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        for task in subtasks:
            task.cancel()
        if subtasks:
            await asyncio.gather(*subtasks, return_exceptions=True)
        if feed_client is not None:
            await feed_client.stop()


@app.websocket("/ws/control/market")
async def ws_control_market(ws: WebSocket):
    await ws.accept()
    log.info("[CONTROL_MARKET] Client connected")
    stream_task: asyncio.Task | None = None
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("type") != "subscribe":
                continue

            if stream_task is not None:
                stream_task.cancel()
                try:
                    await stream_task
                except asyncio.CancelledError:
                    pass

            log.info(
                "[CONTROL_MARKET] subscribe broker=%s symbol=%s token=%s",
                msg.get("broker"),
                msg.get("symbol"),
                msg.get("token"),
            )
            stream_task = asyncio.create_task(_run_market_preview(ws, msg))
    except WebSocketDisconnect:
        log.info("[CONTROL_MARKET] Client disconnected")
    finally:
        if stream_task is not None:
            stream_task.cancel()
            try:
                await stream_task
            except asyncio.CancelledError:
                pass


# ── WebSocket backtest: streams candles one-by-one ──

@app.websocket("/ws/backtest")
async def ws_backtest(ws: WebSocket):
    await ws.accept()
    log.info("[WS] Client connected")
    try:
        # Wait for config message from client
        raw = await ws.receive_text()
        cfg = json.loads(raw)
        log.info("[WS] Received config: %s", cfg)

        token = cfg["token"]
        symbol = cfg["symbol"]
        start_date = cfg["start_date"]
        end_date = cfg["end_date"]
        closing_start = cfg["closing_start"]
        closing_end = cfg["closing_end"]
        long_percent = cfg.get("long_percent", 0.5)
        short_percent = cfg.get("short_percent", 10.0)
        initial_threshold = cfg.get("initial_threshold", 0.1)
        funds = cfg.get("funds", 110000)
        base_funds = cfg.get("base_funds", 100000)
        interval = cfg.get("interval", "ONE_MINUTE")
        speed_ms = cfg.get("speed_ms", 200)

        log.info("[WS] Fetching data for %s (%s) speed=%dms", symbol, token, speed_ms)

        client = get_client()

        # Fetch candles
        data = client.get_historical_data(token, start_date, end_date, interval)
        if not data:
            await ws.send_json({"type": "error", "message": "No historical data found"})
            await ws.close()
            return

        # Fetch previous close
        closing_data = client.get_historical_data(token, closing_start, closing_end, interval)
        if not closing_data:
            await ws.send_json({"type": "error", "message": "No closing data found"})
            await ws.close()
            return

        closing_tick = closing_data[0]
        prev_close = tick_to_dict(closing_tick)

        log.info("[WS] Got %d candles, prev close=%.2f. Starting stream...", len(data), closing_tick.close)

        # Send init message
        await ws.send_json({
            "type": "init",
            "totalCandles": len(data),
            "prevClose": prev_close,
            "symbol": symbol,
            "token": token,
        })

        # Build strategy for tick-by-tick replay
        strategy = Strategy(
            last_tick=closing_tick,
            long_percent=long_percent,
            short_percent=short_percent,
            initial_threshold=initial_threshold,
        )
        model = Backtesting(
            token, data, strategy, funds,
            base_funds=base_funds, symbol=symbol,
        )

        # Replay candle by candle (do NOT call model.run() — we tick manually)
        net_pnl = 0
        total_fees = 0
        last_buy_order = None
        order_count = 0
        paused = False

        # Dump all tick prices to a file for analysis
        price_log_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "logs", f"prices_{symbol}_{start_date.replace(' ','_').replace(':','-')}.txt"
        )
        os.makedirs(os.path.dirname(price_log_path), exist_ok=True)
        price_log = open(price_log_path, "w")
        price_log.write(f"# {symbol} ({token})  {start_date} -> {end_date}\n")
        price_log.write(f"# Strategy: init={initial_threshold}%  long={long_percent}%  short={short_percent}%\n")
        price_log.write(f"# Funds: {funds}  Base: {base_funds}\n")
        price_log.write(f"# Prev close: {closing_tick.close}\n")
        price_log.write(f"{'idx':>5} {'time':>22} {'open':>10} {'high':>10} {'low':>10} {'close':>10} {'%chg':>8} {'event':>8} {'target_sell':>12}\n")
        price_log.write("-" * 110 + "\n")

        last_trade_price = closing_tick.close
        sell_target_profit = None
        sell_target_loss = None
        buy_trigger_price = round(closing_tick.close * (1 + initial_threshold / 100), 4)

        for i, tick in enumerate(data):
            candle = tick_to_dict(tick)

            # Run strategy for this single tick
            order_event = None
            transaction = False
            if model._can_buy(tick) and model.strategy.should_buy(tick):
                model._buy(tick)
                transaction = True
            elif model.strategy.should_sell(tick):
                model._sell(tick)
                transaction = True

            if transaction:
                model.strategy.update_last_tick(tick)
                latest_order = model._orders[-1]
                order_count += 1

                time_str = str(latest_order.time) if latest_order.time else ""
                try:
                    dt = datetime.fromisoformat(time_str)
                    time_display = dt.strftime("%H:%M")
                    unix_ts = int(dt.timestamp())
                except (ValueError, TypeError):
                    time_display = time_str
                    unix_ts = 0

                pnl = 0
                fee = 0
                if latest_order.order_type == "SELL" and last_buy_order:
                    pnl = (latest_order.unit_price * latest_order.quantity) - (
                        last_buy_order.unit_price * last_buy_order.quantity
                    )
                    fee = TRADE_FEE
                    total_fees += fee
                    pnl -= fee
                    net_pnl += pnl

                if latest_order.order_type == "BUY":
                    last_buy_order = latest_order

                decision = model.strategy.last_decision or {}
                order_event = {
                    "time": unix_ts,
                    "timeStr": time_display,
                    "type": latest_order.order_type,
                    "price": float(latest_order.unit_price),
                    "qty": int(latest_order.quantity),
                    "amount": float(latest_order.amount),
                    "pnl": round(pnl, 2),
                    "fee": fee,
                    "net": round(net_pnl, 2),
                    "reason": decision.get("reason", ""),
                    "pct_change": decision.get("pct_change", 0),
                    "threshold": decision.get("threshold", 0),
                    "ref_price": decision.get("ref_price", 0),
                }

                tag = "BUY" if latest_order.order_type == "BUY" else "SELL"
                log.info("  [WS ORDER %02d] %s  price=%.2f  qty=%d  pnl=%.0f  net=%.0f  reason=%s",
                         order_count, tag, order_event['price'], order_event['qty'],
                         order_event['pnl'], order_event['net'], decision.get('reason', ''))

            # Log every tick to file
            pct_from_trade = ((tick.close - last_trade_price) / last_trade_price) * 100 if last_trade_price else 0
            event_str = ""
            target_str = ""
            if transaction:
                evt_type = model._orders[-1].order_type
                reason_str = model.strategy.last_decision.get('reason', '') if model.strategy.last_decision else ''
                event_str = f"<<{evt_type}>> {reason_str}"
                last_trade_price = tick.close
                if evt_type == "BUY":
                    sell_target_profit = round(tick.close * (1 + long_percent / 100), 4)
                    sell_target_loss = round(tick.close * (1 - short_percent / 100), 4)
                    target_str = f"TP≥{sell_target_profit} SL≤{sell_target_loss}"
                else:
                    sell_target_profit = None
                    sell_target_loss = None
            elif sell_target_profit:
                target_str = f"TP≥{sell_target_profit} SL≤{sell_target_loss}"

            price_log.write(
                f"{i:>5} {str(tick.time):>22} {tick.open:>10.2f} {tick.high:>10.2f} "
                f"{tick.low:>10.2f} {tick.close:>10.2f} {pct_from_trade:>+8.3f} {event_str:>8} {target_str:>12}\n"
            )
            price_log.flush()

            # Update strategy levels after trade
            if transaction:
                evt_type = model._orders[-1].order_type
                if evt_type == "BUY":
                    buy_trigger_price = None
                else:
                    buy_trigger_price = round(tick.close * (1 + initial_threshold / 100), 4)

            # Send tick to frontend
            await ws.send_json({
                "type": "tick",
                "index": i,
                "candle": candle,
                "order": order_event,
                "stats": {
                    "fundsRemaining": round(model.funds, 2),
                    "totalShares": model._total_shares,
                    "netPnl": round(net_pnl, 2),
                    "totalFees": round(total_fees, 2),
                    "orderCount": order_count,
                },
                "levels": {
                    "tp": sell_target_profit,
                    "sl": sell_target_loss,
                    "buyTrigger": buy_trigger_price,
                },
            })

            # Check for client commands (speed change, pause, stop) — non-blocking
            try:
                client_msg = await asyncio.wait_for(ws.receive_text(), timeout=0.001)
                cmd = json.loads(client_msg)
                if cmd.get("action") == "speed":
                    speed_ms = cmd["speed_ms"]
                    log.info("[WS] Speed changed to %dms", speed_ms)
                elif cmd.get("action") == "pause":
                    paused = True
                    log.info("[WS] Paused")
                elif cmd.get("action") == "resume":
                    paused = False
                    log.info("[WS] Resumed")
                elif cmd.get("action") == "stop":
                    log.info("[WS] Client requested stop")
                    break
            except asyncio.TimeoutError:
                pass

            # Wait while paused
            while paused:
                try:
                    client_msg = await asyncio.wait_for(ws.receive_text(), timeout=0.1)
                    cmd = json.loads(client_msg)
                    if cmd.get("action") == "resume":
                        paused = False
                        log.info("[WS] Resumed")
                    elif cmd.get("action") == "speed":
                        speed_ms = cmd["speed_ms"]
                    elif cmd.get("action") == "stop":
                        log.info("[WS] Stopped while paused")
                        break
                except asyncio.TimeoutError:
                    pass
            else:
                # Sleep at configured speed
                await asyncio.sleep(speed_ms / 1000.0)
                continue
            break  # if we broke out of the while-paused loop via stop

        # Close price log
        price_log.write(f"\n# Stream ended. Total orders: {order_count}\n")
        price_log.close()
        log.info("[WS] Price log written to %s", price_log_path)

        # Send completion
        total_trades = 0
        wins = 0
        last_buy = None
        for o in model._orders:
            if o.order_type == "BUY":
                last_buy = o
            elif o.order_type == "SELL":
                total_trades += 1
                if last_buy:
                    p = (o.unit_price * o.quantity) - (last_buy.unit_price * last_buy.quantity) - TRADE_FEE
                    if p >= 0:
                        wins += 1
        losses = total_trades - wins
        final_pnl = net_pnl

        await ws.send_json({
            "type": "done",
            "stats": {
                "netPnl": round(final_pnl, 2),
                "totalFees": round(total_fees, 2),
                "returnPct": round((final_pnl / funds) * 100, 2) if funds else 0,
                "totalTrades": total_trades,
                "wins": wins,
                "losses": losses,
                "winRate": round((wins / total_trades) * 100, 1) if total_trades else 0,
                "fundsRemaining": round(model.funds, 2),
            },
        })
        log.info("[WS] Stream complete. %d candles, %d orders, pnl=%.2f",
                 len(data), order_count, final_pnl)

    except WebSocketDisconnect:
        log.info("[WS] Client disconnected")
    except Exception as e:
        log.error("[WS] Error: %s", e, exc_info=True)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
