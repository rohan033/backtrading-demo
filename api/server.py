import sys
import os
import logging

_repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _repo_root)
sys.path.insert(0, os.path.join(_repo_root, "src"))

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from typing import Any, Literal, Optional
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
import asyncio
import contextlib
import json
import re
import uuid
from contextlib import asynccontextmanager

from client import TotpClient
from strategy import Strategy
from backtesting import Backtesting
from api.manual_robo_routes import router as manual_robo_router
from api.ai_research_routes import get_ai_research_store, router as ai_research_router
from api.agent_routes import router as agent_router
from api.agent_agui_routes import router as agent_agui_router
from api.agent_monitor_routes import router as agent_monitor_router
from api.agent_monitor_feed import get_agent_monitor_feed_hub
from api.cursor_agent import cursor_agent_service, handle_cursor_agent_websocket, router as cursor_agent_router
from api.workspace_media import router as workspace_media_router
from api.watchlist_routes import router as watchlist_router
from api.watchlist_panel_routes import router as watchlist_panel_router
from api.traded_instruments_routes import router as traded_instruments_router
from api.trades_pnl_routes import router as trades_pnl_router
from api.market_news_routes import router as market_news_router
from api.trading_session_routes import get_trading_session_store, handle_trading_session_websocket, router as trading_session_router
from api.news_feed import get_news_feed_hub
from api.watchlist_feed import get_watchlist_feed_hub, market_preview_uses_shared_hub
from control_plane.client_mode import normalize_client_mode
from control_plane.engine_registry import EngineRegistry, _parse_datetime
from control_plane.engine_process_manager import EngineProcessManager, REPO_ROOT, engine_live_ws_path
from control_plane.live_engine_proxy import forward_live_json
from control_plane.ops_logging import configure_control_plane_logging, quiet_uvicorn_poll_access_logs
from managers.bgp_log import bgp_error, bgp_info
from control_plane.log_stream import (
    resolve_engine_log_path,
    sse_encode,
    stream_engine_log_events,
)
from control_plane.execution_scheduler import ExecutionScheduler
from control_plane.execution_sources import (
    DEFAULT_EXECUTION_SOURCE,
    EXECUTION_SOURCE_AI_RESEARCH,
    EXECUTION_SOURCE_MOMENTUM_TRADE,
)
from control_plane.execution_source_links import ensure_research_source_on_engine
from control_plane.news_poller import get_news_poller
from control_plane.insider_poller import get_insider_poller
from control_plane.agent_monitor import get_agent_monitor_service
from control_plane.trading_schedule import default_schedule, resolve_schedule, trading_day_options
from brokers.angel.adapters.portfolio import angel_portfolio_rows_from_holdings
from brokers.etoro.adapters.portfolio import (
    enrich_etoro_orders_snapshot as _enrich_etoro_orders_snapshot,
    etoro_display_map_for_records as _etoro_display_map_for_records,
    etoro_display_symbol as _etoro_display_symbol,
    etoro_instrument_id as _etoro_instrument_id,
    etoro_instrument_to_search_row as _etoro_instrument_to_search_row,
    etoro_position_to_portfolio_row as _etoro_position_to_portfolio_row,
    etoro_symbol_map_for_records as _etoro_symbol_map_for_records,
    metadata_from_etoro_record as _metadata_from_etoro_record,
    mock_search_rows as _mock_search_rows,
    portfolio_row_needs_symbol_enrichment as _portfolio_row_needs_symbol_enrichment,
    rehydrate_etoro_portfolio_rows as _rehydrate_etoro_portfolio_rows,
)
from brokers.etoro.client import EtoroApiError
from brokers.fake.adapters.portfolio import fake_portfolio_rows
from event.db_event_consumer import DbEventWriter, resolve_live_events_db_path
from event.platform_notifier import emit_strategy_event, shutdown_platform_notifier
from event.telegram_env import load_telegram_env
from event.telegram_inbound import start_telegram_inbound_services, stop_telegram_inbound_services
from event.strategy_events import (
    STRATEGY_CANCELLED,
    STRATEGY_CREATED,
    STRATEGY_DEPLOYED,
    STRATEGY_RUNNING,
    STRATEGY_SCHEDULED,
    STRATEGY_STOPPED,
)

load_dotenv()
load_telegram_env()
_cursor_api_env_path = REPO_ROOT / ".cursor-api.env"
if _cursor_api_env_path.is_file():
    load_dotenv(_cursor_api_env_path, override=True)
    log_pre = logging.getLogger("backtrading")
    log_pre.info("[CONTROL] Loaded Cursor agent env from %s", _cursor_api_env_path)
else:
    logging.getLogger("backtrading").debug(
        "[CONTROL] %s not found; copy .cursor-api.env.example if using Strategy AI",
        _cursor_api_env_path,
    )

_control_plane_log_path = configure_control_plane_logging()
log = logging.getLogger("backtrading")
log.info("[CONTROL] Control plane logging to %s", _control_plane_log_path)

app = FastAPI(title="Backtrading API")


@app.get("/health")
def health_check():
    from backtrading.observability.health import control_plane_health_payload

    return control_plane_health_payload()


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(manual_robo_router)
app.include_router(cursor_agent_router)
app.include_router(ai_research_router)
app.include_router(agent_router)
app.include_router(agent_agui_router)
app.include_router(agent_monitor_router)
app.include_router(workspace_media_router)
app.include_router(watchlist_router)
app.include_router(watchlist_panel_router)
app.include_router(traded_instruments_router)
app.include_router(trades_pnl_router)
app.include_router(market_news_router)
app.include_router(trading_session_router)

IST = timezone(timedelta(hours=5, minutes=30))
TRADE_FEE = 25  # ₹25 per buy-sell round trip
engine_registry = EngineRegistry()
engine_registry.ensure_default_engine()
engine_process_manager = EngineProcessManager(engine_registry)
_engine_sweeper_task: Optional[asyncio.Task] = None
_scheduled_executions_task: Optional[asyncio.Task] = None
execution_scheduler: ExecutionScheduler | None = None
_live_events_db: Optional[DbEventWriter] = None
_news_poller = get_news_poller(
    broadcast=get_news_feed_hub().broadcast_notifications,
)
_insider_poller = get_insider_poller(
    broadcast=get_news_feed_hub().broadcast_insider_transactions,
)


def get_live_events_db() -> DbEventWriter:
    global _live_events_db
    if _live_events_db is None:
        _live_events_db = DbEventWriter(db_path=resolve_live_events_db_path())
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


def _remove_position_from_portfolio_cache(broker: str, account_env: str, position_id: str) -> None:
    key = _portfolio_cache_key(broker, account_env)
    entry = _control_portfolio_cache.get(key)
    if entry is None:
        return
    data, cached_at = entry
    pid = str(position_id)
    filtered = [
        row
        for row in data
        if str(row.get("position_id") or row.get("positionId") or "") != pid
    ]
    if len(filtered) != len(data):
        _control_portfolio_cache[key] = (filtered, cached_at)


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


ExecutionSourceId = Literal["user", "ai_research", "ai_chatbot_panel", "chart_opportunity_auto", "momentum-trade"]
InstrumentClass = Literal["equity", "crypto"]


class ControlPlaneExecutionRequest(BaseModel):
    executor_id: Optional[str] = None
    source_id: ExecutionSourceId = DEFAULT_EXECUTION_SOURCE
    source_meta_id: Optional[str] = None
    broker: str = "angel"
    account_env: str = "live"
    strategy_name: str = "default"
    symbol: str
    token: str
    exchange: str = "NSE"
    close_price: float
    long_percent: float = 1.0
    short_percent: float = 10.0
    stop_loss_amount: Optional[float] = None
    initial_threshold: float = 0.2
    max_available_capital: float = 100000
    allow_partial_stocks: bool = False
    use_fake_client: bool = False
    client_mode: Optional[str] = None
    feed_mode: str = "websocket"
    feed_tick_sample_every: int = Field(default=0, ge=0, le=300)
    tick_sample_every: int = Field(default=1, ge=1, le=300)
    schedule_enabled: bool = False
    scheduled_date: Optional[str] = None
    start_immediately: bool = False
    instrument_class: InstrumentClass = "equity"

    @model_validator(mode="after")
    def normalize_source_meta_id(self):
        meta = (self.source_meta_id or "").strip() or None
        if self.source_id == EXECUTION_SOURCE_AI_RESEARCH:
            if not meta:
                raise ValueError('source_meta_id is required when source_id is "ai_research"')
            self.source_meta_id = meta
        else:
            self.source_meta_id = None
        self.client_mode = normalize_client_mode(self.broker, self.client_mode)
        if self.broker != "etoro":
            self.instrument_class = "equity"
        elif self.instrument_class not in {"equity", "crypto"}:
            self.instrument_class = "equity"
        return self


class MomentumEnterRequest(BaseModel):
    broker: str = "etoro"
    account_env: str = "demo"
    symbol: str
    token: str
    exchange: str = "ETORO"
    close_price: float
    long_percent: float = 5.0
    short_percent: float = 1.0
    no_take_profit: bool = False
    stop_loss_amount: Optional[float] = None
    max_available_capital: float = 100000
    allow_partial_stocks: bool = True
    instrument_class: InstrumentClass = "equity"
    watchlist_id: Optional[int] = None
    source_id: Optional[ExecutionSourceId] = None
    source_meta_id: Optional[str] = None


class BulkDeleteOldExecutionsRequest(BaseModel):
    older_than_days: int = Field(default=30, ge=0, le=365)


ACTIVE_CONTROLLED_EXECUTION_STATUSES = frozenset({"running", "starting", "stale", "scheduled"})
NON_DELETABLE_EXECUTION_STATUSES = frozenset({"running", "starting", "scheduled"})


# ── Endpoints ──

@asynccontextmanager
async def control_plane_lifespan(_app: FastAPI):
    global _engine_sweeper_task, _scheduled_executions_task, execution_scheduler
    quiet_uvicorn_poll_access_logs()
    _engine_sweeper_task = asyncio.create_task(_mark_stale_engines_loop())
    execution_scheduler = ExecutionScheduler(engine_registry.list_engines, _fire_scheduled_execution)
    execution_scheduler.poll_once()
    _scheduled_executions_task = asyncio.create_task(_scheduled_executions_loop())
    await cursor_agent_service.startup()
    await start_telegram_inbound_services()
    await _news_poller.start()
    await _insider_poller.start()
    await get_agent_monitor_service().start()
    try:
        yield
    finally:
        await get_agent_monitor_service().stop()
        await _insider_poller.stop()
        await _news_poller.stop()
        await stop_telegram_inbound_services()
        await cursor_agent_service.shutdown()
        if _scheduled_executions_task:
            _scheduled_executions_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await _scheduled_executions_task
            _scheduled_executions_task = None
        execution_scheduler = None
        if _engine_sweeper_task:
            _engine_sweeper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await _engine_sweeper_task

        stopped = engine_process_manager.stop_all_engines()
        if stopped:
            log.info("[CONTROL] Shutdown stopped %d live trading server(s)", len(stopped))
        shutdown_platform_notifier()


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


def _notify_controlled_strategy(engine: dict, action: str, **kwargs) -> None:
    if _is_controlled_execution(engine):
        emit_strategy_event(action, engine, **kwargs)


def _fire_scheduled_execution(execution_id: str) -> None:
    try:
        _start_controlled_execution(execution_id, trigger="scheduler")
    except HTTPException as exc:
        raise RuntimeError(str(exc.detail)) from exc


async def _scheduled_executions_loop():
    interval_seconds = max(5, int(os.getenv("SCHEDULED_EXECUTION_POLL_SECONDS", "30")))
    log.info("[SCHEDULER] DB poll loop started (every %ss)", interval_seconds)
    while True:
        await asyncio.sleep(interval_seconds)
        if execution_scheduler is None:
            continue
        try:
            execution_scheduler.poll_once()
        except Exception as exc:
            log.error("[SCHEDULER] Poll loop failed: %s", exc, exc_info=True)


_SCHEDULE_METADATA_KEYS = (
    "scheduled_start_at",
    "trading_day",
    "market_open_label",
    "schedule_label",
)


def _clear_schedule_from_metadata(metadata: dict) -> dict:
    cleaned = {key: value for key, value in metadata.items() if key not in _SCHEDULE_METADATA_KEYS}
    config = dict(cleaned.get("execution_config") or {})
    config["schedule_enabled"] = False
    config["scheduled_date"] = None
    config["start_immediately"] = False
    cleaned["execution_config"] = config
    return cleaned


def _unschedule_engine_if_scheduled(execution_id: str, engine: dict) -> dict | None:
    if str(engine.get("status") or "").lower() != "scheduled":
        return None
    metadata = _clear_schedule_from_metadata(engine.get("metadata") or {})
    return engine_registry.update_engine(
        execution_id,
        {"status": "pending", "metadata": metadata},
    )

@app.get("/api/control/engines", operation_id="get_engines", summary="List data-plane engines")
def list_data_plane_engines(status: Optional[str] = None):
    return {"status": True, "data": engine_registry.list_engines(status=status)}


@app.get("/api/control/engines/{engine_id}", operation_id="get_engine", summary="Get one data-plane engine")
def get_data_plane_engine(engine_id: str):
    engine = engine_registry.get_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.post("/api/control/engines", operation_id="register_engine", summary="Register a data-plane engine")
def register_data_plane_engine(req: DataPlaneEngineRequest):
    return {"status": True, "data": engine_registry.upsert_engine(req.model_dump(exclude_none=True))}


@app.patch("/api/control/engines/{engine_id}", operation_id="update_engine", summary="Update a data-plane engine")
def update_data_plane_engine(engine_id: str, req: DataPlaneEngineUpdate):
    engine = engine_registry.update_engine(engine_id, req.model_dump(exclude_none=True))
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.post("/api/control/engines/{engine_id}/heartbeat", operation_id="record_engine_heartbeat", summary="Record engine heartbeat")
def heartbeat_data_plane_engine(engine_id: str, payload: dict = Body(default_factory=dict)):
    previous = engine_registry.get_engine(engine_id)
    previous_status = str((previous or {}).get("status") or "").lower()
    engine = engine_registry.record_heartbeat(engine_id, payload or {"status": "running"})
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    new_status = str(engine.get("status") or "").lower()
    if (
        previous
        and _is_controlled_execution(engine)
        and previous_status in {"starting"}
        and new_status == "running"
    ):
        _notify_controlled_strategy(
            engine,
            STRATEGY_RUNNING,
            previous_state=previous_status,
            trigger="heartbeat",
        )
    return {"status": True, "data": engine}


@app.get("/api/control/engines/{engine_id}/logs", operation_id="get_engine_logs", summary="Get engine log metadata")
def get_engine_log_meta(engine_id: str):
    engine = engine_registry.get_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")

    log_path = resolve_engine_log_path(engine_registry, engine_id)
    if not log_path:
        raise HTTPException(status_code=404, detail="Log file path is not available for this engine")

    exists = log_path.exists()
    size = log_path.stat().st_size if exists else 0
    metadata = engine.get("metadata") or {}
    return {
        "status": True,
        "data": {
            "engine_id": engine_id,
            "path": str(log_path),
            "exists": exists,
            "size": size,
            "log_file": metadata.get("log_file"),
        },
    }


@app.get("/api/control/engines/{engine_id}/logs/stream")
async def stream_engine_logs(engine_id: str, request: Request):
    engine = engine_registry.get_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")

    log_path = resolve_engine_log_path(engine_registry, engine_id)
    if not log_path:
        raise HTTPException(status_code=404, detail="Log file path is not available for this engine")

    async def event_stream():
        try:
            async for event in stream_engine_log_events(log_path):
                if await request.is_disconnected():
                    break
                yield sse_encode({"engine_id": engine_id, **event})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("[CONTROL] Log stream failed engine=%s", engine_id)
            yield sse_encode({"type": "error", "engine_id": engine_id, "message": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/control/engines/{engine_id}/stop", operation_id="stop_engine", summary="Stop a data-plane engine")
def stop_data_plane_engine(engine_id: str):
    engine = engine_process_manager.stop_engine(engine_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True, "data": engine}


@app.delete("/api/control/engines/{engine_id}", operation_id="delete_engine", summary="Delete a data-plane engine")
def delete_data_plane_engine(engine_id: str):
    if not engine_registry.delete_engine(engine_id):
        raise HTTPException(status_code=404, detail="Data-plane engine not found")
    return {"status": True}


@app.get("/api/control/search", operation_id="search_instruments", summary="Search broker instruments")
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
            client = await _etoro_trading_client(account_env)
            instruments = await client.asearch_instruments(q)
            rows = [_etoro_instrument_to_search_row(item) for item in instruments]
            if rows:
                log.info(
                    "[CONTROL_SEARCH] etoro returned %d rows for %r using account_env=%s",
                    len(rows), q, account_env,
                )
                return {"status": True, "data": rows}

            log.warning(
                "[CONTROL_SEARCH] etoro returned 0 instruments for %r account_env=%s",
                q,
                account_env,
            )
            return {
                "status": False,
                "message": f"No eToro instruments found for '{q}' in {account_env} environment",
                "data": [],
            }

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
        error_message = str(e)
        if hasattr(e, "status_code") and hasattr(e, "payload"):
            error_message = f"{e} payload={getattr(e, 'payload', None)}"
        log.error(
            "[CONTROL_SEARCH] failed broker=%s env=%s q=%r error=%s",
            broker_name,
            account_env,
            q,
            error_message,
            exc_info=True,
        )
        return {"status": False, "message": error_message, "data": []}


def _is_controlled_execution(engine: dict) -> bool:
    if engine.get("id") == "local-live-engine":
        return False
    metadata = engine.get("metadata") or {}
    if metadata.get("source") == "controlled_execution":
        return True
    if metadata.get("executor_payload"):
        return True
    return False


def _is_deletable_stopped_execution(
    engine: dict,
    cutoff: datetime,
    *,
    all_stopped: bool = False,
) -> bool:
    if not _is_controlled_execution(engine):
        return False
    status = str(engine.get("status") or "").lower()
    if status in NON_DELETABLE_EXECUTION_STATUSES:
        return False
    if all_stopped:
        return True
    created = _parse_datetime(engine.get("created_at"))
    return created is not None and created < cutoff


@app.get("/api/control/executions", operation_id="get_strategies", summary="List saved strategy executions")
def list_controlled_executions():
    store = get_ai_research_store()
    executions = []
    for engine in engine_registry.list_engines():
        if not _is_controlled_execution(engine):
            continue
        engine = ensure_research_source_on_engine(engine_registry, store, engine)
        metadata = engine.get("metadata") or {}
        executions.append(
            {
                "execution_id": engine["id"],
                "engine": engine,
                "executor": metadata.get("executor_payload") or {},
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
        "stop_loss_amount": req.stop_loss_amount,
        "initial_threshold": req.initial_threshold,
        "max_available_capital": req.max_available_capital,
        "allow_partial_stocks": req.allow_partial_stocks,
        "tick_sample_every": max(1, int(req.tick_sample_every or 1)),
        "strategy_type": req.strategy_name,
        "instrument_class": req.instrument_class,
    }
    broker = "fake" if req.use_fake_client else req.broker
    label = f"{req.broker}-{req.symbol}-strategy-{req.strategy_name}"
    schedule = resolve_schedule(
        broker,
        schedule_enabled=req.schedule_enabled,
        scheduled_date=req.scheduled_date,
        start_immediately=req.start_immediately,
    )
    metadata = {
        "source": "controlled_execution",
        "source_id": req.source_id,
        "source_meta_id": req.source_meta_id,
        "executor_payload": executor_payload,
        "execution_config": req.model_dump(),
        "exchange": req.exchange,
        "client_mode": req.client_mode,
        "use_fake_client": req.use_fake_client,
    }
    status = "pending"
    if schedule:
        metadata.update(schedule)
        status = "scheduled"
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
        "status": status,
        "metadata": metadata,
    }
    return executor_id, executor_payload, engine_config


@app.get("/api/control/executions/default-schedule", operation_id="get_default_strategy_schedule", summary="Get default strategy schedule")
def get_default_execution_schedule(broker: str = "angel", use_fake_client: bool = False):
    broker_name = "fake" if use_fake_client else broker
    return {"status": True, "data": default_schedule(broker_name)}


@app.get("/api/control/executions/trading-day-options", operation_id="get_trading_day_options", summary="List trading-day schedule options")
def get_trading_day_options(
    broker: str = "angel",
    use_fake_client: bool = False,
    count: int = 4,
):
    broker_name = "fake" if use_fake_client else broker
    safe_count = max(1, min(int(count or 4), 10))
    return {"status": True, "data": trading_day_options(broker_name, count=safe_count)}


@app.post("/api/control/executions", operation_id="create_strategy", summary="Create a saved strategy execution")
def create_controlled_execution(req: ControlPlaneExecutionRequest):
    try:
        execution_id, executor_payload, engine_config = _controlled_execution_payload(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        engine = engine_registry.upsert_engine(engine_config)
    except Exception as e:
        log.error("[CONTROL] Failed to create execution: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    status = str(engine.get("status") or "pending").lower()
    if status == "scheduled":
        _notify_controlled_strategy(engine, STRATEGY_SCHEDULED, trigger="create")
    else:
        _notify_controlled_strategy(engine, STRATEGY_CREATED, trigger="create")
    log.info(
        "[CONTROL] Created %s execution %s for %s source_id=%s",
        engine.get("status") or "pending",
        execution_id,
        req.symbol,
        req.source_id,
    )
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": engine,
            "executor": executor_payload,
        },
    }


@app.post(
    "/api/control/momentum/enter",
    operation_id="momentum_enter",
    summary="Momentum entry: check balance, place a bracket order immediately, then attach a monitor-only strategy",
)
async def momentum_enter(req: MomentumEnterRequest):
    """Fast-path entry for momentum trades.

    Unlike the normal strategy flow (which spawns an engine that waits for a
    threshold cross before buying), this:
      1. Checks available cash for the account environment.
      2. Sizes the position (scaling down to available cash when needed).
      3. Places the bracket order (entry + take-profit + stop-loss) immediately
         from the warm server-side client — no per-deploy websocket auth.
      4. Registers an order poll job so the monitor engine tracks the position.
      5. Spins up a monitor-only strategy (initial_threshold set very high so it
         never places its own orders) purely to observe / manage the position.
    """
    if req.broker != "etoro":
        raise HTTPException(
            status_code=400,
            detail="Momentum entry currently supports eToro bracket orders only",
        )

    env = _normalize_etoro_account_env(req.account_env)

    from brokers.etoro.order_client import EtoroV2BracketOrderClient
    from brokers.etoro.order_helpers import compute_stop_loss_price
    from utils import order_quantity_from_capital

    # 1. Balance check.
    try:
        order_client = EtoroV2BracketOrderClient(account_env=env)
        order_client.generate_session()
        available_cash = await order_client.aget_available_cash()
    except Exception as exc:
        log.error("[MOMENTUM] balance fetch failed env=%s: %s", env, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Could not fetch account balance: {exc}") from exc

    if available_cash <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient funds in {env} account (available ${available_cash:.2f})",
        )

    # 2. Size the position — scale down to what's actually available.
    capital = min(float(req.max_available_capital), available_cash)

    # The entry is a market order, so the actual fill price comes from eToro.
    # TP/SL are computed off close_price as an approximation — that's acceptable
    # for our app; the exact levels can be verified on eToro.
    entry_price = float(req.close_price)
    if entry_price <= 0:
        raise HTTPException(status_code=400, detail="Invalid entry price")

    # No-take-profit mode (high-growth: let the winner run) leaves TP unset.
    take_profit_price = (
        None if req.no_take_profit else round(entry_price * (1 + req.long_percent / 100), 2)
    )
    stop_loss_price = compute_stop_loss_price(
        entry_price,
        capital,
        stop_loss_amount=req.stop_loss_amount,
        short_percent=req.short_percent,
    )
    quantity = order_quantity_from_capital(
        capital, entry_price, allow_partial=req.allow_partial_stocks
    )
    if quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"Available cash ${capital:.2f} too small to buy {req.symbol} at ${entry_price:.2f}",
        )

    log.info(
        "[MOMENTUM] enter symbol=%s env=%s capital=%.2f (avail=%.2f) entry=%.2f qty=%s TP=%s SL=%.2f",
        req.symbol, env, capital, available_cash, entry_price, quantity,
        "none" if take_profit_price is None else f"{take_profit_price:.2f}", stop_loss_price,
    )

    # 3. Place the bracket order immediately.
    try:
        buy_result = await order_client.abuy_with_take_profit_stop_loss(
            ltp=entry_price,
            available_capital=capital,
            symbol=req.symbol,
            token=req.token,
            exchange=req.exchange,
            take_profit_rate=take_profit_price,
            stop_loss_rate=stop_loss_price,
            instrument_class=req.instrument_class,
            quantity=quantity,
        )
    except Exception as exc:
        log.error("[MOMENTUM] bracket order failed symbol=%s: %s", req.symbol, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Order placement failed: {exc}") from exc

    order_id = (buy_result or {}).get("order_id")
    if not order_id:
        raise HTTPException(
            status_code=502,
            detail=(buy_result or {}).get("error_message") or "eToro did not return an order id",
        )

    # 4. Create the monitor-only strategy and register the poll job so the
    #    engine tracks the position we just opened.
    link_source_id = req.source_id or EXECUTION_SOURCE_MOMENTUM_TRADE
    link_meta_id = (req.source_meta_id or "").strip() or None
    if link_source_id == EXECUTION_SOURCE_AI_RESEARCH and not link_meta_id:
        raise HTTPException(
            status_code=400,
            detail='source_meta_id is required when source_id is "ai_research"',
        )

    monitor_req = ControlPlaneExecutionRequest(
        source_id=link_source_id,
        source_meta_id=link_meta_id,
        broker="etoro",
        account_env=env,
        strategy_name="one-percent",
        symbol=req.symbol,
        token=req.token,
        exchange=req.exchange,
        close_price=entry_price,
        long_percent=req.long_percent,
        short_percent=req.short_percent,
        stop_loss_amount=req.stop_loss_amount,
        # Monitor-only: an unreachable threshold means the strategy never
        # generates its own BUY signal — it only observes the open position.
        initial_threshold=10000,
        max_available_capital=req.max_available_capital,
        allow_partial_stocks=req.allow_partial_stocks,
        use_fake_client=False,
        client_mode="bracket",
        feed_mode="websocket",
        tick_sample_every=1,
        schedule_enabled=False,
        start_immediately=True,
        instrument_class=req.instrument_class,
    )

    try:
        execution_id, executor_payload, engine_config = _controlled_execution_payload(monitor_req)
        engine_registry.upsert_engine(engine_config)
    except Exception as exc:
        log.error("[MOMENTUM] monitor execution create failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Order placed but monitor setup failed: {exc}") from exc

    db = get_live_events_db()
    db.upsert_order_poll_job(
        executor_id=execution_id,
        order_id=order_id,
        broker="etoro",
        account_env=env,
        engine_id=execution_id,
        status="RUNNING",
    )
    db.log_event(
        str(order_id),
        "BUY_ORDER_PLACED",
        {
            "executor_id": execution_id,
            "source": EXECUTION_SOURCE_MOMENTUM_TRADE,
            "symbol": req.symbol,
            "token": req.token,
            "exchange": req.exchange,
            "entry_price": entry_price,
            "quantity": quantity,
            "take_profit_price": take_profit_price,
            "stop_loss_price": buy_result.get("stop_loss_rate", stop_loss_price),
            "account_env": env,
        },
    )

    # Durable P&L ledger entry for reporting. Best-effort: never fail the trade.
    try:
        from control_plane.trades_pnl_store import get_trades_pnl_store

        get_trades_pnl_store().record_entry(
            execution_id=execution_id,
            order_id=str(order_id),
            source=EXECUTION_SOURCE_MOMENTUM_TRADE,
            broker="etoro",
            account_env=env,
            symbol=req.symbol,
            tradingsymbol=req.symbol,
            symboltoken=req.token,
            exchange=req.exchange,
            side="buy",
            quantity=quantity,
            capital=capital,
            entry_price=entry_price,
            take_profit_price=take_profit_price,
            stop_loss_price=buy_result.get("stop_loss_rate", stop_loss_price),
        )
    except Exception as exc:
        log.debug("[MOMENTUM] trades_pnl entry record skipped: %s", exc)

    # 5. Spin up the monitor engine.
    try:
        _start_controlled_execution(execution_id, trigger="momentum")
    except HTTPException:
        raise
    except Exception as exc:
        log.error("[MOMENTUM] monitor engine start failed execution=%s: %s", execution_id, exc, exc_info=True)
        # The order is already live and tracked via the poll job; surface a soft warning.
        return {
            "status": True,
            "data": {
                "execution_id": execution_id,
                "order_id": order_id,
                "quantity": quantity,
                "capital": round(capital, 2),
                "available_cash": round(available_cash, 2),
                "take_profit_price": take_profit_price,
                "stop_loss_price": buy_result.get("stop_loss_rate", stop_loss_price),
                "monitor_started": False,
                "warning": f"Order placed and tracked, but monitor engine failed to start: {exc}",
            },
        }

    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "order_id": order_id,
            "quantity": quantity,
            "capital": round(capital, 2),
            "available_cash": round(available_cash, 2),
            "take_profit_price": take_profit_price,
            "stop_loss_price": buy_result.get("stop_loss_rate", stop_loss_price),
            "monitor_started": True,
        },
    }


@app.post("/api/control/executions/bulk/unschedule", operation_id="unschedule_all_strategies", summary="Unschedule all scheduled strategies")
def unschedule_all_controlled_executions():
    unscheduled: list[str] = []
    failed: list[str] = []

    for engine in engine_registry.list_engines():
        if not _is_controlled_execution(engine):
            continue

        execution_id = engine.get("id")
        if not execution_id:
            continue

        if str(engine.get("status") or "").lower() != "scheduled":
            continue

        updated = _unschedule_engine_if_scheduled(execution_id, engine)
        if updated:
            unscheduled.append(execution_id)
            _notify_controlled_strategy(
                updated,
                STRATEGY_CANCELLED,
                previous_state="scheduled",
                trigger="unschedule_all",
            )
            log.info("[CONTROL] Unscheduled execution %s (unschedule-all)", execution_id)
        else:
            failed.append(execution_id)

    return {
        "status": True,
        "data": {
            "unscheduled": unscheduled,
            "failed": failed,
            "count": len(unscheduled),
        },
    }


@app.post(
    "/api/control/executions/bulk/delete-old",
    operation_id="delete_old_strategies",
    summary="Delete stopped strategies older than a given age",
)
def delete_old_controlled_executions(req: BulkDeleteOldExecutionsRequest):
    cutoff = datetime.now(timezone.utc) - timedelta(days=req.older_than_days)
    all_stopped = req.older_than_days == 0
    deleted: list[str] = []
    skipped: list[str] = []

    for engine in engine_registry.list_engines():
        execution_id = engine.get("id")
        if not execution_id:
            continue
        if not _is_deletable_stopped_execution(engine, cutoff, all_stopped=all_stopped):
            continue
        if engine_registry.delete_engine(execution_id):
            deleted.append(execution_id)
            log.info(
                "[CONTROL] Deleted old execution %s (older than %s days)",
                execution_id,
                req.older_than_days,
            )
        else:
            skipped.append(execution_id)

    return {
        "status": True,
        "data": {
            "deleted": deleted,
            "skipped": skipped,
            "count": len(deleted),
            "older_than_days": req.older_than_days,
        },
    }


@app.post("/api/control/executions/stop-all", operation_id="stop_all_strategies", summary="Stop all running strategies")
def stop_all_controlled_executions():
    stopped: list[str] = []
    failed: list[str] = []

    for engine in engine_registry.list_engines():
        if not _is_controlled_execution(engine):
            continue

        execution_id = engine.get("id")
        if not execution_id:
            continue

        status = str(engine.get("status") or "").lower()
        if status not in {"starting", "running", "stale"}:
            continue

        if engine.get("pid"):
            result = engine_process_manager.stop_engine(execution_id)
        else:
            result = engine_registry.update_engine(
                execution_id,
                {"status": "stopped", "pid": None},
            )

        if result:
            stopped.append(execution_id)
            _notify_controlled_strategy(
                result,
                STRATEGY_STOPPED,
                previous_state=status,
                trigger="stop_all",
            )
            log.info("[CONTROL] Stopped execution %s (stop-all)", execution_id)
        else:
            failed.append(execution_id)

    return {
        "status": True,
        "data": {
            "stopped": stopped,
            "failed": failed,
            "count": len(stopped),
        },
    }


@app.post("/api/control/executions/{execution_id}/start", operation_id="start_strategy", summary="Start/deploy a saved strategy")
def start_controlled_execution(execution_id: str):
    return _start_controlled_execution(execution_id, trigger="manual")


def _start_controlled_execution(execution_id: str, *, trigger: str = "manual"):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    if not _is_controlled_execution(engine):
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    metadata = engine.get("metadata") or {}

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
                "client_mode": normalize_client_mode(
                    engine.get("broker") or config.get("broker"),
                    metadata.get("client_mode") or config.get("client_mode"),
                ),
                "feed_mode": config.get("feed_mode") or metadata.get("feed_mode") or "websocket",
                "feed_tick_sample_every": int(
                    config.get("feed_tick_sample_every")
                    if config.get("feed_tick_sample_every") is not None
                    else metadata.get("feed_tick_sample_every", 0)
                ),
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
    _notify_controlled_strategy(
        started,
        STRATEGY_DEPLOYED,
        previous_state=str(engine.get("status") or "").lower() or None,
        trigger=trigger,
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


@app.get("/api/control/executions/{execution_id}", operation_id="get_strategy", summary="Get one saved strategy execution")
def get_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    metadata = engine.get("metadata") or {}
    if metadata.get("source") != "controlled_execution":
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    engine = ensure_research_source_on_engine(engine_registry, get_ai_research_store(), engine)
    metadata = engine.get("metadata") or {}

    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": engine,
            "executor": metadata.get("executor_payload"),
        },
    }


@app.get("/api/control/executions/{execution_id}/duplicate-template", operation_id="get_strategy_duplicate_template", summary="Get a duplicate-ready strategy template")
def duplicate_execution_template(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    if not _is_controlled_execution(engine):
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    metadata = engine.get("metadata") or {}
    config = dict(metadata.get("execution_config") or {})
    executor_payload = dict(metadata.get("executor_payload") or {})
    if not config:
        config = {
            "broker": engine.get("broker"),
            "symbol": engine.get("symbol"),
            "token": engine.get("token"),
            "strategy_name": engine.get("strategy_name"),
            "account_env": engine.get("account_env"),
            "exchange": metadata.get("exchange") or executor_payload.get("exchange"),
            "client_mode": normalize_client_mode(
                engine.get("broker") or config.get("broker"),
                metadata.get("client_mode") or config.get("client_mode"),
            ),
            "feed_mode": metadata.get("feed_mode") or config.get("feed_mode") or "websocket",
            "use_fake_client": metadata.get("use_fake_client") or False,
            "executor_id": executor_payload.get("executor_id") or execution_id,
            "close_price": executor_payload.get("close_price"),
            "long_percent": executor_payload.get("long_percent"),
            "short_percent": executor_payload.get("short_percent"),
            "stop_loss_amount": executor_payload.get("stop_loss_amount"),
            "initial_threshold": executor_payload.get("initial_threshold"),
            "max_available_capital": executor_payload.get("max_available_capital"),
            "allow_partial_stocks": executor_payload.get("allow_partial_stocks", False),
            "tick_sample_every": executor_payload.get("tick_sample_every", 1),
            "instrument_class": config.get("instrument_class")
            or executor_payload.get("instrument_class")
            or "equity",
        }
    broker = config.get("broker") or engine.get("broker") or "angel"
    symbol = config.get("symbol") or engine.get("symbol") or "symbol"
    strategy_name = config.get("strategy_name") or engine.get("strategy_name") or "default"
    copy_id = _execution_id(broker, symbol, strategy_name)
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


@app.post("/api/control/executions/{execution_id}/unschedule", operation_id="unschedule_strategy", summary="Unschedule one saved strategy")
def unschedule_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    if not _is_controlled_execution(engine):
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    if str(engine.get("status") or "").lower() != "scheduled":
        raise HTTPException(status_code=400, detail="Execution is not scheduled")

    updated = _unschedule_engine_if_scheduled(execution_id, engine)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to unschedule execution")

    metadata = updated.get("metadata") or {}
    _notify_controlled_strategy(
        updated,
        STRATEGY_CANCELLED,
        previous_state="scheduled",
        trigger="unschedule",
    )
    log.info("[CONTROL] Unscheduled execution %s", execution_id)
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": updated,
            "executor": metadata.get("executor_payload"),
        },
    }


@app.post("/api/control/executions/{execution_id}/stop", operation_id="stop_strategy", summary="Stop one saved strategy")
def stop_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    if not _is_controlled_execution(engine):
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    metadata = engine.get("metadata") or {}

    if engine.get("pid") and engine.get("status") in {"starting", "running", "stale"}:
        stopped = engine_process_manager.stop_engine(execution_id)
    else:
        stopped = engine_registry.update_engine(
            execution_id,
            {"status": "stopped", "pid": None},
        )

    if not stopped:
        raise HTTPException(status_code=500, detail="Failed to stop execution")

    _notify_controlled_strategy(
        stopped,
        STRATEGY_STOPPED,
        previous_state=str(engine.get("status") or "").lower() or None,
        trigger="stop",
    )
    log.info("[CONTROL] Stopped execution %s", execution_id)
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "engine": stopped,
            "executor": metadata.get("executor_payload"),
        },
    }


@app.delete(
    "/api/control/executions/{execution_id}",
    operation_id="delete_strategy",
    summary="Delete one saved strategy execution",
)
def delete_controlled_execution(execution_id: str):
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")

    if not _is_controlled_execution(engine):
        raise HTTPException(status_code=400, detail="Not a controlled execution")

    status = str(engine.get("status") or "").lower()
    previous_state = status or None

    if status == "scheduled":
        updated = _unschedule_engine_if_scheduled(execution_id, engine)
        if updated:
            _notify_controlled_strategy(
                updated,
                STRATEGY_CANCELLED,
                previous_state="scheduled",
                trigger="delete",
            )
    elif status in {"starting", "running", "stale"}:
        if engine.get("pid"):
            stopped = engine_process_manager.stop_engine(execution_id)
        else:
            stopped = engine_registry.update_engine(
                execution_id,
                {"status": "stopped", "pid": None},
            )
        if stopped:
            _notify_controlled_strategy(
                stopped,
                STRATEGY_STOPPED,
                previous_state=previous_state,
                trigger="delete",
            )

    if not engine_registry.delete_engine(execution_id):
        raise HTTPException(status_code=500, detail="Failed to delete execution")

    log.info("[CONTROL] Deleted execution %s", execution_id)
    return {
        "status": True,
        "data": {
            "execution_id": execution_id,
            "deleted": True,
        },
    }


def _execution_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def _execution_slug(broker: str, symbol: str, strategy_name: str) -> str:
    raw = f"{broker}-{symbol}-strategy-{strategy_name}".lower()
    return re.sub(r"-+", "-", "".join(ch if ch.isalnum() else "-" for ch in raw).strip("-"))


def _execution_id(broker: str, symbol: str, strategy_name: str) -> str:
    return f"{_execution_slug(broker, symbol, strategy_name)}-{_execution_timestamp()}"


@app.get("/api/control/events", operation_id="get_control_events", summary="List control-plane events")
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


@app.get("/api/control/trades", operation_id="get_control_trades", summary="List control-plane trades")
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


@app.get("/api/control/orders", operation_id="get_control_orders", summary="List control-plane orders")
def get_control_orders(executor_id: Optional[str] = None, limit: int = 100):
    orders = get_live_events_db().query_orders_snapshot(executor_id=executor_id, limit=limit)
    return {"status": True, "data": orders}


def _resolve_execution_order_poll_job(execution_id: str) -> dict[str, Any] | None:
    db = get_live_events_db()
    job = db.get_order_poll_job(execution_id)
    if job:
        return job
    orders = db.query_orders_snapshot(executor_id=execution_id, limit=5)
    for order in orders.values():
        order_id = order.get("order_id")
        if order_id:
            return {
                "executor_id": execution_id,
                "order_id": str(order_id),
                "status": "STOPPED",
            }
    return None


class PositionCloseNotifyContext(BaseModel):
    source: Optional[str] = None
    ticker: Optional[str] = None
    symbol_name: Optional[str] = None
    buy_price: Optional[float] = None
    sell_price: Optional[float] = None
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None
    close_reason: Optional[str] = None
    take_profit_config: Optional[str] = None
    stop_loss_config: Optional[str] = None


class ClosePositionRequest(BaseModel):
    units: Optional[float] = None
    instrument_id: Optional[int] = None
    max_positions: Optional[int] = None
    notify: Optional[PositionCloseNotifyContext] = None


def _etoro_close_error_detail(exc: Exception, request_debug: dict | None = None) -> dict:
    response = getattr(exc, "payload", None)
    if isinstance(response, dict) and "request" in response:
        request_debug = response.get("request") or request_debug
        response = response.get("response", response)
    return {
        "message": str(exc),
        "debug": {
            "request": request_debug,
            "response": response,
        },
    }


def _log_etoro_close_result(label: str, result: dict) -> None:
    request_debug = result.get("request") or {}
    response = result.get("response")
    log.info(
        "[%s] request=%s response=%s",
        label,
        json.dumps(request_debug, default=str),
        json.dumps(response, default=str) if response is not None else "(empty)",
    )


def _position_close_notify_details(
    *,
    account_env: str,
    position_id: str,
    notify: PositionCloseNotifyContext | None = None,
    executor_id: str | None = None,
    position_row: dict | None = None,
) -> dict:
    details: dict[str, Any] = {
        "broker": "etoro",
        "account_env": account_env,
        "position_id": str(position_id),
        "source": "ui",
    }
    if executor_id:
        details["executor_id"] = executor_id
    if notify is not None:
        for key, value in notify.model_dump().items():
            if value is not None:
                details[key] = value
    if position_row:
        if not details.get("ticker"):
            details["ticker"] = (
                position_row.get("tradingsymbol")
                or position_row.get("symbol")
                or position_row.get("instrument_display_name")
            )
        if details.get("buy_price") is None:
            for key in ("averageprice", "openRate", "open_rate", "entry_price"):
                if position_row.get(key) is not None:
                    details["buy_price"] = position_row.get(key)
                    break
    return details


def _notify_ui_position_closed(**kwargs) -> None:
    try:
        from event.position_close_notify import notify_ui_position_closed

        notify_ui_position_closed(_position_close_notify_details(**kwargs))
    except Exception as exc:
        log.debug("[CONTROL_ETORO] telegram position close notify skip: %s", exc)


def _execution_engine(execution_id: str) -> dict[str, Any]:
    engine = engine_registry.get_engine(execution_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Execution not found")
    return engine


@app.get(
    "/api/control/executions/{execution_id}/positions",
    operation_id="get_execution_positions",
    summary="List persisted open and closed positions for an execution",
)
def get_execution_positions(execution_id: str):
    positions = get_live_events_db().get_executor_positions(execution_id)
    return {"status": True, "data": positions}


@app.get(
    "/api/control/executions/{execution_id}/candles",
    operation_id="get_execution_candles",
    summary="Fetch 1-minute OHLCV candles for an execution chart (eToro)",
)
async def get_execution_candles(execution_id: str, count: int = 100):
    engine = _execution_engine(execution_id)
    broker = str(engine.get("broker") or "").lower()
    if broker != "etoro":
        raise HTTPException(status_code=400, detail="Candles endpoint is only available for eToro executions")

    metadata = engine.get("metadata") or {}
    executor_payload = metadata.get("executor_payload") or {}
    symbol = engine.get("symbol") or executor_payload.get("symbol")
    token = engine.get("token") or executor_payload.get("token")
    account_env = engine.get("account_env") or "demo"
    if not symbol or not token:
        raise HTTPException(status_code=400, detail="Execution is missing symbol or token")

    from brokers.etoro.candles import (
        BOOTSTRAP_CANDLE_COUNT,
        CANDLE_INTERVAL_ONE_MINUTE,
        aget_historical_candles,
    )

    safe_count = max(1, min(int(count or BOOTSTRAP_CANDLE_COUNT), BOOTSTRAP_CANDLE_COUNT))
    try:
        client = await _etoro_trading_client(account_env)
        instrument_id = await client._instrument_id(symbol, str(token))
        if instrument_id is None:
            raise HTTPException(status_code=404, detail="Could not resolve eToro instrument id")

        candles = await aget_historical_candles(
            client,
            instrument_id,
            interval=CANDLE_INTERVAL_ONE_MINUTE,
            count=safe_count,
            direction="desc",
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "[CONTROL_ETORO] candles failed execution=%s symbol=%s token=%s: %s",
            execution_id,
            symbol,
            token,
            exc,
            exc_info=True,
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    from managers.candle_store import CandleStore

    store = CandleStore()
    store.bootstrap(candles)
    # Skip LTP here — live engine WS owns the forming bar; avoids a second rates API call and 429s.

    return {
        "status": True,
        "data": store.bars(),
        "meta": {
            "interval": CANDLE_INTERVAL_ONE_MINUTE,
            "count": safe_count,
            "broker": broker,
            "symbol": symbol,
            "token": str(token),
        },
    }


@app.get(
    "/api/watchlist/candles",
    operation_id="get_watchlist_symbol_candles",
    summary="Fetch recent 1-minute OHLCV candles for a watchlist symbol (used to pre-seed local price history)",
)
async def get_watchlist_symbol_candles(
    broker: str,
    account_env: str,
    symbol: str,
    token: str,
    count: int = 250,
):
    """Returns up to `count` recent 1-minute candles for the symbol so the frontend
    can pre-populate its local price-change windows (1m/2m/5m/10m/…) immediately
    on page load instead of waiting for the WebSocket feed to accumulate enough data.
    Currently only supports eToro; Angel returns an empty list."""
    broker_lower = broker.lower()
    if broker_lower != "etoro":
        # Graceful no-op for unsupported brokers; frontend falls back to live-only mode
        return {"status": True, "data": []}

    from brokers.etoro.candles import (
        CANDLE_INTERVAL_ONE_MINUTE,
        aget_historical_candles,
    )

    safe_count = max(10, min(int(count), 1000))
    try:
        client = await _etoro_trading_client(account_env)
        instrument_id = await client._instrument_id(symbol, str(token))
        if instrument_id is None:
            return {"status": True, "data": []}

        candles = await aget_historical_candles(
            client,
            instrument_id,
            interval=CANDLE_INTERVAL_ONE_MINUTE,
            count=safe_count,
            direction="desc",
        )
        from managers.candle_store import CandleStore

        store = CandleStore()
        candles = store.bootstrap(candles)
        log.info(
            "[WATCHLIST_CANDLES] symbol=%s token=%s env=%s candles=%d",
            symbol, token, account_env, len(candles),
        )
        return {"status": True, "data": candles}
    except Exception as exc:
        log.warning("[WATCHLIST_CANDLES] failed symbol=%s: %s", symbol, exc)
        # Return empty gracefully — frontend falls back to live-only mode
        return {"status": True, "data": []}


@app.get(
    "/api/watchlist/candles/history",
    operation_id="get_watchlist_symbol_candles_history",
    summary="Fetch older 1-minute OHLCV candles before the oldest bar already loaded",
)
async def get_watchlist_symbol_candles_history(
    broker: str,
    account_env: str,
    symbol: str,
    token: str,
    before: int | None = None,
    end: int | None = None,
    start: int | None = None,
    minutes: int = 120,
    count: int = 100,
):
    """Returns up to `count` bars in [start, end).

    eToro has no start/end query params on its candles API — we simulate pagination by
    fetching desc and filtering client-side. Pass `before` (or `end`) as the exclusive
    end of the window; omit `start` to use `before - minutes`.
    """
    broker_lower = broker.lower()
    if broker_lower != "etoro":
        return {"status": True, "data": [], "loaded_count": 0}

    from brokers.etoro.candles import (
        CANDLE_HISTORY_2H_MINUTES,
        DEFAULT_HISTORY_PAGE_COUNT,
        aget_historical_candles_before,
    )

    safe_minutes = max(1, min(int(minutes or CANDLE_HISTORY_2H_MINUTES), 1000))
    safe_count = max(1, min(int(count or DEFAULT_HISTORY_PAGE_COUNT), 1000))
    end_time = (int(before if before is not None else end) // 60) * 60
    if end_time <= 0:
        return {"status": True, "data": [], "loaded_count": 0}
    start_time = (
        (int(start) // 60) * 60
        if start is not None
        else end_time - safe_minutes * 60
    )
    try:
        client = await _etoro_trading_client(account_env)
        instrument_id = await client._instrument_id(symbol, str(token))
        if instrument_id is None:
            return {"status": True, "data": [], "loaded_count": 0}

        candles, interval_used = await aget_historical_candles_before(
            client,
            instrument_id,
            before_time=end_time,
            minutes=max(1, (end_time - start_time) // 60),
            count=safe_count,
        )
        log.info(
            "[WATCHLIST_CANDLES] window symbol=%s token=%s env=%s start=%d end=%d count=%d interval=%s candles=%d",
            symbol, token, account_env, start_time, end_time, safe_count, interval_used, len(candles),
        )
        return {
            "status": True,
            "data": candles,
            "loaded_count": len(candles),
            "interval": interval_used,
            "start": start_time,
            "end": end_time,
        }
    except Exception as exc:
        log.warning("[WATCHLIST_CANDLES] older failed symbol=%s: %s", symbol, exc)
        return {"status": True, "data": [], "loaded_count": 0}


@app.post(
    "/api/control/executions/{execution_id}/positions/{position_id}/close",
    operation_id="close_execution_position",
    summary="Close a position directly via eToro (works even when the live engine is stopped)",
)
async def close_execution_position(
    execution_id: str,
    position_id: str,
    req: ClosePositionRequest,
):
    db = get_live_events_db()
    poll_job = db.get_order_poll_job(execution_id)
    order_id = str(poll_job.get("order_id")) if poll_job else None

    # Resolve account_env: prefer what the live engine registered, fall back to DB poll job.
    engine = engine_registry.get_engine(execution_id)
    account_env = (
        (engine or {}).get("account_env")
        or (poll_job or {}).get("account_env")
        or "demo"
    )

    request_details = {
        "executor_id": execution_id,
        "position_id": str(position_id),
        "units": req.units,
        "instrument_id": req.instrument_id,
        "source": "control_plane_direct",
        "account_env": account_env,
    }
    db.log_event(order_id, "POSITION_CLOSE_REQUESTED", request_details)
    bgp_info(
        "control_plane_position_close",
        "close_requested",
        **request_details,
        order_id=order_id,
    )

    try:
        client = await _etoro_trading_client(account_env)
        position_row = None
        for row in get_live_events_db().get_executor_positions(execution_id):
            if str(row.get("position_id") or row.get("positionId") or "") == str(position_id):
                position_row = row
                break
        closed = await client.aclose_position(
            position_id,
            units=req.units,
            instrument_id=req.instrument_id,
        )
    except EtoroApiError as exc:
        log.error(
            "[CONTROL_ETORO] close_position failed execution=%s position=%s env=%s: %s",
            execution_id, position_id, account_env, exc, exc_info=True,
        )
        bgp_error(
            "control_plane_position_close",
            "close_failed",
            **request_details,
            order_id=order_id,
            error=str(exc),
        )
        db.log_event(
            order_id,
            "POSITION_CLOSE_FAILED",
            {**request_details, "error": str(exc)},
        )
        raise HTTPException(status_code=502, detail=_etoro_close_error_detail(exc)) from exc
    except Exception as exc:
        log.error(
            "[CONTROL_ETORO] close_position failed execution=%s position=%s env=%s: %s",
            execution_id, position_id, account_env, exc, exc_info=True,
        )
        bgp_error(
            "control_plane_position_close",
            "close_failed",
            **request_details,
            order_id=order_id,
            error=str(exc),
        )
        db.log_event(
            order_id,
            "POSITION_CLOSE_FAILED",
            {**request_details, "error": str(exc)},
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if not closed.get("closed"):
        bgp_error(
            "control_plane_position_close",
            "close_not_confirmed",
            **request_details,
            order_id=order_id,
        )
        db.log_event(
            order_id,
            "POSITION_CLOSE_FAILED",
            {**request_details, "error": "eToro returned failure without exception"},
        )
        raise HTTPException(status_code=502, detail="eToro did not confirm position close")

    _log_etoro_close_result("CONTROL_ETORO", closed)

    bgp_info(
        "control_plane_position_close",
        "close_confirmed",
        **request_details,
        order_id=order_id,
    )
    db.log_event(order_id, "POSITION_CLOSED", {**request_details, "source": "control_plane_direct"})

    # Mark the position as closed in the local DB immediately so the next GET /positions
    # reflects the new state without waiting for the next remote poll.
    db.mark_position_closed(str(position_id), execution_id)

    # Record the exit + realized P&L in the durable ledger. No-op unless this
    # execution has a momentum entry recorded. Best-effort: never fail the close.
    try:
        from control_plane.trades_pnl_store import get_trades_pnl_store

        notify = req.notify
        get_trades_pnl_store().record_exit(
            execution_id=execution_id,
            position_id=str(position_id),
            exit_price=getattr(notify, "sell_price", None) if notify else None,
            entry_price=getattr(notify, "buy_price", None) if notify else None,
            pnl=getattr(notify, "pnl", None) if notify else None,
            pnl_pct=getattr(notify, "pnl_pct", None) if notify else None,
            close_reason=(getattr(notify, "close_reason", None) if notify else None) or "manual",
        )
    except Exception as exc:
        log.debug("[CONTROL_ETORO] trades_pnl exit record skipped: %s", exc)

    try:
        from control_plane.agent_trade_completion import log_position_close_for_execution

        log_position_close_for_execution(
            execution_id,
            position_id=str(position_id),
            position_row=position_row,
            engine=engine,
        )
    except Exception as exc:
        log.debug("[CONTROL_ETORO] agent trade log skip: %s", exc)

    _remove_position_from_portfolio_cache("etoro", account_env, str(position_id))

    _notify_ui_position_closed(
        account_env=account_env,
        position_id=str(position_id),
        notify=req.notify,
        executor_id=execution_id,
        position_row=position_row,
    )

    log.info(
        "[CONTROL_ETORO] close_position OK execution=%s position=%s env=%s units=%s",
        execution_id, position_id, account_env, req.units,
    )
    return {
        "status": True,
        "position_id": position_id,
        "closed": True,
        "debug": closed,
    }


@app.get(
    "/api/control/executions/{execution_id}/order-poll",
    operation_id="get_execution_order_poll",
    summary="Read persisted order-status poll job state for the orders UI",
)
def get_execution_order_poll(execution_id: str):
    job = _resolve_execution_order_poll_job(execution_id)
    if not job:
        return {"status": True, "data": None}
    return {"status": True, "data": job}


@app.post(
    "/api/control/executions/{execution_id}/order-poll/start",
    operation_id="start_execution_order_poll",
    summary="Mark order-status polling RUNNING in SQLite for the live engine poller",
)
def start_execution_order_poll(execution_id: str):
    db = get_live_events_db()
    job = _resolve_execution_order_poll_job(execution_id)
    if not job or not job.get("order_id"):
        raise HTTPException(
            status_code=404,
            detail=f"No order found to poll for execution '{execution_id}'",
        )

    engine = engine_registry.get_engine(execution_id)
    account_env = (engine or {}).get("account_env") or "live"
    db.upsert_order_poll_job(
        executor_id=execution_id,
        order_id=str(job["order_id"]),
        broker="etoro",
        account_env=account_env,
        engine_id=execution_id,
        status="RUNNING",
    )
    return {"status": True, "data": db.get_order_poll_job(execution_id, job["order_id"])}


@app.post(
    "/api/control/executions/{execution_id}/order-poll/stop",
    operation_id="stop_execution_order_poll",
    summary="Mark order-status polling STOPPED in SQLite for the live engine poller",
)
def stop_execution_order_poll(execution_id: str):
    db = get_live_events_db()
    job = db.get_order_poll_job(execution_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"No poll job for execution '{execution_id}'")
    db.set_order_poll_job_status(execution_id, job["order_id"], "STOPPED")
    return {"status": True, "data": db.get_order_poll_job(execution_id, job["order_id"])}


@app.get("/api/control/orders/{order_id}", operation_id="get_control_order_detail", summary="Get v2 order lookup and positions")
def get_control_order_detail(order_id: str):
    db = get_live_events_db()
    lookup_row = db.get_order_lookup(order_id)
    positions = db.get_order_positions(order_id)
    if not lookup_row and not positions:
        raise HTTPException(status_code=404, detail=f"No v2 lookup data for order '{order_id}'")
    return {
        "status": True,
        "data": {
            "order_id": order_id,
            "lookup": lookup_row.get("lookup") if lookup_row else None,
            "lookup_updated_at": lookup_row.get("updated_at") if lookup_row else None,
            "account_env": lookup_row.get("account_env") if lookup_row else None,
            "positions": positions,
        },
    }


@app.get("/api/control/event-sessions", operation_id="get_event_sessions", summary="List live event sessions")
def get_control_event_sessions(limit: int = 100):
    sessions = get_live_events_db().query_event_sessions(limit=limit)
    return {"status": True, "data": sessions}


@app.get("/api/control/event-sessions/{session_id}/events", operation_id="get_event_session_events", summary="List events for one session")
def get_control_event_session_events(session_id: str, limit: int = 300):
    db = get_live_events_db()
    events = db.query_trading_events(executor_id=session_id, limit=limit)
    if not events:
        events = db.query_events(executor_id=session_id, limit=limit)
    return {"status": True, "data": events}


@app.get("/api/control/portfolio", operation_id="get_portfolio", summary="Get broker portfolio holdings")
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
        if (
            broker_name == "etoro"
            and any(_portfolio_row_needs_symbol_enrichment(row) for row in cached_rows)
        ):
            try:
                client = await _etoro_trading_client(account_env)
                cached_rows = await _rehydrate_etoro_portfolio_rows(client, cached_rows)
                _set_portfolio_cache(broker_name, account_env, cached_rows)
            except Exception as enrich_exc:
                log.warning(
                    "[CONTROL_PORTFOLIO] cache rehydrate failed broker=%s env=%s: %s",
                    broker_name,
                    account_env,
                    enrich_exc,
                )
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
            rows = fake_portfolio_rows()
            _set_portfolio_cache(broker_name, account_env, rows)
            return {"status": True, "broker": broker_name, "account_env": account_env, "data": rows}

        if broker_name == "etoro":
            client = await _etoro_trading_client(account_env)
            positions = await client.aget_positions()
            symbol_map = await _etoro_symbol_map_for_records(client, positions)
            display_map = await _etoro_display_map_for_records(client, positions)
            rows = [
                _etoro_position_to_portfolio_row(item, symbol_map, display_map)
                for item in positions
            ]
            _set_portfolio_cache(broker_name, account_env, rows)
            log.info("[CONTROL_PORTFOLIO] etoro returned %d positions", len(rows))
            return {"status": True, "broker": broker_name, "account_env": account_env, "data": rows}

        log.info("[CONTROL_PORTFOLIO] fetching fresh angel holdings...")
        client = get_client()
        raw = client._client.holding().get("data") or []
        rows = angel_portfolio_rows_from_holdings(raw)
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


@app.get(
    "/api/control/instruments/display",
    operation_id="get_instrument_display",
    summary="Get broker instrument display metadata",
)
async def control_plane_instrument_display(
    broker: str = "etoro",
    account_env: str = "demo",
    instrument_ids: str = "",
):
    broker_name = (broker or "etoro").lower()
    if broker_name != "etoro":
        return {"status": False, "message": f"Instrument display lookup is not supported for {broker_name}", "data": {}}

    parsed_ids: list[int] = []
    seen: set[int] = set()
    for part in instrument_ids.split(","):
        text = part.strip()
        if not text:
            continue
        try:
            instrument_id = int(text)
        except ValueError:
            continue
        if instrument_id in seen:
            continue
        seen.add(instrument_id)
        parsed_ids.append(instrument_id)

    if not parsed_ids:
        return {"status": True, "broker": broker_name, "account_env": account_env, "data": {}}

    try:
        client = await _etoro_trading_client(account_env)
        symbol_map = await client.aget_instrument_symbol_map(parsed_ids)
        display_map = await _etoro_display_map_for_records(client, [{"instrumentID": i} for i in parsed_ids])
        instrument_records = await client.aget_instrument_records(parsed_ids)
        data: dict[str, dict] = {}
        for instrument_id in parsed_ids:
            display = dict(display_map.get(instrument_id, {}))
            instrument = instrument_records.get(instrument_id)
            if instrument:
                for key, value in _metadata_from_etoro_record(instrument).items():
                    if value and not display.get(key):
                        display[key] = value
            mapped_symbol = symbol_map.get(instrument_id)
            ticker = mapped_symbol or display.get("tradingsymbol") or display.get("instrument_display_name")
            if not ticker or str(ticker).isdigit():
                ticker = str(instrument_id)
            row = {
                "tradingsymbol": str(ticker),
                "symbol": display.get("instrument_display_name") or str(ticker),
                **display,
            }
            data[str(instrument_id)] = row
        return {"status": True, "broker": broker_name, "account_env": account_env, "data": data}
    except Exception as e:
        log.error(
            "[CONTROL_INSTRUMENT_DISPLAY] failed broker=%s env=%s: %s",
            broker_name,
            account_env,
            e,
            exc_info=True,
        )
        return {"status": False, "broker": broker_name, "account_env": account_env, "message": str(e), "data": {}}


_etoro_trading_clients: dict[str, Any] = {}


def _normalize_etoro_account_env(account_env: str | None) -> str:
    return "demo" if (account_env or "demo").lower() == "demo" else "live"


async def _etoro_trading_client(account_env: str):
    from brokers.etoro.trading_client import EtoroTradingClient

    env = _normalize_etoro_account_env(account_env)
    cached = _etoro_trading_clients.get(env)
    if cached is not None:
        return cached

    client = EtoroTradingClient(account_env=env)
    client.generate_session()
    _etoro_trading_clients[env] = client
    return client


def _capture_traded_instruments(rows: list[dict], *, broker: str = "etoro", account_env: str = "demo") -> None:
    """Persist instruments seen in positions into the permanent "past traded" registry.

    Best-effort: never let a bookkeeping failure break the positions response.
    """
    if not rows:
        return
    try:
        from control_plane.traded_instruments_store import get_traded_instruments_store

        store = get_traded_instruments_store()
        for row in rows:
            try:
                store.upsert_from_position_row(row, broker=broker, account_env=account_env)
            except Exception:
                continue
    except Exception as exc:
        log.debug("[TRADED_INSTRUMENTS] capture skipped: %s", exc)


def _sync_past_traded_watchlist(*, broker: str = "etoro", account_env: str = "demo") -> None:
    from control_plane.past_traded_sync import sync_past_traded_watchlist

    sync_past_traded_watchlist(broker=broker, account_env=account_env)


@app.get("/api/control/etoro/positions", operation_id="get_etoro_positions", summary="Get eToro open positions")
async def control_plane_etoro_positions(
    account_env: str = "demo",
    refresh: bool = False,
):
    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    log.info("[CONTROL_ETORO] positions request env=%s refresh=%s", env, refresh)
    cached_rows, cached_at, cache_fresh = _get_portfolio_cache_entry("etoro", env)
    if cached_rows is not None and cache_fresh and not refresh:
        return {
            "status": True,
            "broker": "etoro",
            "account_env": env,
            "data": cached_rows,
            "raw_count": len(cached_rows),
            "cached": True,
        }

    try:
        client = await _etoro_trading_client(env)
        positions = await client.aget_positions()
        symbol_map = await _etoro_symbol_map_for_records(client, positions)
        display_map = await _etoro_display_map_for_records(client, positions)
        rows = [
            _etoro_position_to_portfolio_row(item, symbol_map, display_map)
            for item in positions
        ]
        _capture_traded_instruments(rows, account_env=env)
        _sync_past_traded_watchlist(broker="etoro", account_env=env)
        _set_portfolio_cache("etoro", env, rows)
        log.info("[CONTROL_ETORO] positions env=%s count=%d", env, len(rows))
        return {
            "status": True,
            "broker": "etoro",
            "account_env": env,
            "data": rows,
            "raw": positions,
            "raw_count": len(positions),
            "cached": False,
        }
    except Exception as e:
        log.error("[CONTROL_ETORO] positions failed env=%s: %s", env, e, exc_info=True)
        if cached_rows is not None:
            return {
                "status": True,
                "broker": "etoro",
                "account_env": env,
                "data": cached_rows,
                "raw_count": len(cached_rows),
                "cached": True,
                "stale": True,
                "message": str(e),
            }
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post(
    "/api/control/etoro/positions/{position_id}/close",
    operation_id="close_etoro_position",
    summary="Close an eToro position directly by broker position id",
)
async def control_plane_etoro_close_position(
    position_id: str,
    account_env: str = "demo",
    req: ClosePositionRequest = ClosePositionRequest(),
):
    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    request_debug = {
        "position_id": position_id,
        "account_env": env,
        "units": req.units,
        "instrument_id": req.instrument_id,
    }
    log.info(
        "[CONTROL_ETORO] direct close position=%s env=%s units=%s instrument=%s",
        position_id,
        env,
        req.units,
        req.instrument_id,
    )
    try:
        client = await _etoro_trading_client(env)
        closed = await client.aclose_position(
            position_id,
            units=req.units,
            instrument_id=req.instrument_id,
        )
    except EtoroApiError as exc:
        log.error(
            "[CONTROL_ETORO] direct close failed position=%s env=%s request=%s response=%s",
            position_id,
            env,
            json.dumps(request_debug, default=str),
            json.dumps(getattr(exc, "payload", None), default=str),
            exc_info=True,
        )
        raise HTTPException(status_code=502, detail=_etoro_close_error_detail(exc, request_debug)) from exc
    except Exception as exc:
        log.error(
            "[CONTROL_ETORO] direct close failed position=%s env=%s: %s",
            position_id,
            env,
            exc,
            exc_info=True,
        )
        raise HTTPException(status_code=502, detail=_etoro_close_error_detail(exc, request_debug)) from exc

    _log_etoro_close_result("CONTROL_ETORO", closed)
    _remove_position_from_portfolio_cache("etoro", env, str(position_id))
    _notify_ui_position_closed(
        account_env=env,
        position_id=str(position_id),
        notify=req.notify,
    )
    log.info("[CONTROL_ETORO] direct close OK position=%s env=%s", position_id, env)
    return {
        "status": True,
        "broker": "etoro",
        "account_env": env,
        "position_id": position_id,
        "closed": True,
        "debug": closed,
    }


@app.get("/api/control/etoro/orders", operation_id="get_etoro_orders", summary="Get eToro pending and active orders")
async def control_plane_etoro_orders(account_env: str = "demo"):
    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    log.info("[CONTROL_ETORO] orders request env=%s", env)
    try:
        client = await _etoro_trading_client(env)
        snapshot = await client.aget_orders_snapshot()
        order_records = [
            *(snapshot.get("orders") or []),
            *(snapshot.get("orders_for_open") or []),
            *(snapshot.get("orders_for_close") or []),
        ]
        symbol_map = await _etoro_symbol_map_for_records(client, order_records)
        enriched = _enrich_etoro_orders_snapshot(snapshot, symbol_map)
        total = sum(len(enriched.get(key) or []) for key in ("orders", "orders_for_open", "orders_for_close"))
        log.info(
            "[CONTROL_ETORO] orders env=%s total=%d open=%d close=%d limit=%d",
            env,
            total,
            len(enriched.get("orders_for_open") or []),
            len(enriched.get("orders_for_close") or []),
            len(enriched.get("orders") or []),
        )
        return {
            "status": True,
            "broker": "etoro",
            "account_env": env,
            "data": enriched,
            "counts": {
                "orders": len(enriched.get("orders") or []),
                "orders_for_open": len(enriched.get("orders_for_open") or []),
                "orders_for_close": len(enriched.get("orders_for_close") or []),
                "total": total,
            },
        }
    except Exception as e:
        log.error("[CONTROL_ETORO] orders failed env=%s: %s", env, e, exc_info=True)
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/api/portfolio", operation_id="get_account_portfolio", summary="Get Angel account holdings")
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


@app.get("/api/search", operation_id="search_scrip", summary="Search scrip symbols and tokens")
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


@app.get("/api/historical/{token}", operation_id="get_historical_candles", summary="Get historical OHLC candles")
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


# ── WebSocket proxy: browser → control plane → live engine ──

@app.websocket("/ws/control/engines/{engine_id}/live")
async def ws_proxy_engine_live(ws: WebSocket, engine_id: str):
    engine = engine_registry.get_engine(engine_id)
    if not engine:
        await ws.close(code=4404, reason="Engine not found")
        return

    port = engine.get("port")
    if not port:
        await ws.close(code=4409, reason="Engine not running")
        return

    upstream_url = f"ws://127.0.0.1:{int(port)}/ws/live"
    await ws.accept()
    log.info("[CONTROL_ENGINE_WS] client connected engine_id=%s upstream=%s", engine_id, upstream_url)

    try:
        import websockets
    except ImportError as exc:
        log.error("[CONTROL_ENGINE_WS] missing websockets package: %s", exc)
        await ws.close(code=1011, reason="websockets package required")
        return

    try:
        async with websockets.connect(upstream_url) as upstream:
            async def forward_upstream() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await ws.send_bytes(message)
                    else:
                        await ws.send_text(message)

            async def forward_client() -> None:
                while True:
                    message = await ws.receive()
                    if message["type"] == "websocket.disconnect":
                        break
                    payload = message.get("text")
                    if payload is None and message.get("bytes") is not None:
                        payload = message["bytes"]
                    if payload is not None:
                        await upstream.send(payload)

            upstream_task = asyncio.create_task(forward_upstream())
            client_task = asyncio.create_task(forward_client())
            done, pending = await asyncio.wait(
                {upstream_task, client_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            for task in done:
                with contextlib.suppress(Exception):
                    task.result()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("[CONTROL_ENGINE_WS] proxy ended engine_id=%s error=%s", engine_id, e)
    finally:
        log.info("[CONTROL_ENGINE_WS] client disconnected engine_id=%s", engine_id)


# ── WebSocket market preview for create/launch panel ──

async def _run_market_preview(ws: WebSocket, cfg: dict) -> None:
    from brokers.interfaces import Subscription, TickData
    from brokers.angel.feed_config import angel_uses_websocket_feed

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
            subscription = Subscription(exchange=exchange, symbol=symbol, token=token)
            if angel_uses_websocket_feed(cfg.get("feed_mode")):
                from brokers.angel.feed_client import AngelWebsocketFeedClient
                from brokers.angel.trading_client import AngelOneTradingClient

                angel_client = AngelOneTradingClient()
                angel_client.generate_session()
                feed_client = AngelWebsocketFeedClient.from_trading_client(angel_client)
                feed_client.add_tick_callback(on_tick)
                await feed_client.start()
                await feed_client.sync_subscriptions([subscription])
            else:
                from brokers.angel.trading_client import AngelOneTradingClient

                angel_client = AngelOneTradingClient()
                angel_client.generate_session()

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


@app.websocket("/ws/control/cursor-agent")
async def ws_control_cursor_agent(ws: WebSocket):
    await handle_cursor_agent_websocket(ws)


@app.websocket("/ws/watchlist")
async def ws_watchlist(ws: WebSocket):
    await get_watchlist_feed_hub().handle(ws)


@app.websocket("/ws/news")
async def ws_news(ws: WebSocket):
    await get_news_feed_hub().handle(ws)


@app.websocket("/ws/agent/monitor")
async def ws_agent_monitor(ws: WebSocket):
    await get_agent_monitor_feed_hub().handle(ws)


@app.websocket("/ws/control/trading-sessions/{session_id}")
async def ws_trading_session_events(ws: WebSocket, session_id: str, since_id: int = 0):
    await handle_trading_session_websocket(ws, session_id, since_id=since_id)


@app.websocket("/ws/control/market")
async def ws_control_market(ws: WebSocket):
    await ws.accept()
    log.info("[CONTROL_MARKET] Client connected")
    hub = get_watchlist_feed_hub()
    legacy_task: asyncio.Task | None = None
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("type") != "subscribe":
                continue

            if legacy_task is not None:
                legacy_task.cancel()
                try:
                    await legacy_task
                except asyncio.CancelledError:
                    pass
                legacy_task = None

            if market_preview_uses_shared_hub(msg):
                await hub.set_market_preview_subscription(ws, msg)
                continue

            await hub.clear_market_preview_subscription(ws)
            log.info(
                "[CONTROL_MARKET] subscribe broker=%s symbol=%s token=%s (legacy)",
                msg.get("broker"),
                msg.get("symbol"),
                msg.get("token"),
            )
            legacy_task = asyncio.create_task(_run_market_preview(ws, msg))
    except WebSocketDisconnect:
        log.info("[CONTROL_MARKET] Client disconnected")
    finally:
        await hub.clear_market_preview_subscription(ws)
        if legacy_task is not None:
            legacy_task.cancel()
            try:
                await legacy_task
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


from api.control_plane_mcp import mount_control_plane_mcp
from fastmcp.utilities.lifespan import combine_lifespans

_, _mcp_app = mount_control_plane_mcp(app)
app.router.lifespan_context = combine_lifespans(control_plane_lifespan, _mcp_app.lifespan)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
