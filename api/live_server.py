"""
Live Trading Engine Server

Exposes the StrategyExecutor engine via REST + WebSocket.
Default port: 8080 (configurable via LIVE_PORT env var or --port flag)

Usage:
    python -m api.live_server
    python -m api.live_server --port 9000
    LIVE_PORT=9000 python -m api.live_server
    python -m api.live_server --fake   # use FakeTradingClient for testing
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from logzero import logger
from pydantic import BaseModel

from control_plane.ops_logging import live_engine_log_path
from brokers.interfaces import TickData
from brokers.etoro.env import load_etoro_env
from event.db_event_consumer import DbEventWriter
from event.event_manager import EventManager
from managers.strategy_executor import StrategyExecutor
from managers.order_manager import OrderManager
from managers.tick_provider import TickProvider
from managers.trading_manager import TradingManager
from strategy_config import StrategyConfig


# ─── WebSocket Connection Manager ─────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active_connections.append(ws)
        logger.info(
            "[WS] Client connected (%d total) engine_id=%s",
            len(self.active_connections),
            getattr(self, "engine_id", None),
        )

    def disconnect(self, ws: WebSocket):
        self.active_connections.remove(ws)
        logger.info("[WS] Client disconnected (%d remaining)", len(self.active_connections))

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active_connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active_connections.remove(ws)


# ─── Live Engine ──────────────────────────────────────────────────────────────

class LiveEngine:
    def __init__(
        self,
        use_fake_client: bool = False,
        account_env: str = "live",
        broker: str = "angel",
        engine_id: str | None = None,
        control_url: str | None = None,
        heartbeat_interval: float = 5.0,
        symbol: str | None = None,
        token: str | None = None,
        strategy_name: str = "default",
        client_mode: str = "standard",
    ):
        self.use_fake_client = use_fake_client or broker == "fake"
        self.account_env = "demo" if account_env == "demo" else "live"
        self.broker = "fake" if self.use_fake_client else broker
        self.engine_id = engine_id
        self.control_url = control_url.rstrip("/") if control_url else None
        self.heartbeat_interval = heartbeat_interval
        self.symbol = symbol
        self.token = token
        self.strategy_name = strategy_name
        self.client_mode = "bracket" if client_mode == "bracket" else "standard"
        self.client = None
        self.db_writer: Optional[DbEventWriter] = None
        self.event_manager: Optional[EventManager] = None
        self.trading_manager: Optional[TradingManager] = None
        self.order_manager: Optional[OrderManager] = None
        self.tick_provider: Optional[TickProvider] = None
        self.executors: dict[str, StrategyExecutor] = {}
        self.ws_manager = ConnectionManager()
        self.ws_manager.engine_id = self.engine_id
        self._broadcast_queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._broadcast_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._logged_first_ticks: set[str] = set()
        self._tick_stats = {"generated": 0, "broadcast": 0, "dropped_no_clients": 0}
        self._last_flow_log_at = 0.0
        self._last_no_client_warn_at = 0.0

    async def start(self):
        if self.use_fake_client:
            from tests.fake_test_client import FakeTradingClient, FakeTickGenerator
            tick_gen = FakeTickGenerator(base_price=1000.0, mode="trending_up")
            self.client = FakeTradingClient(tick_gen)
            logger.info("[ENGINE] Using FakeTradingClient (test mode)")
        elif self.broker == "etoro":
            from brokers.etoro.trading_client import EtoroBracketTradingClient, EtoroTradingClient
            client_cls = EtoroBracketTradingClient if self.client_mode == "bracket" else EtoroTradingClient
            self.client = client_cls(account_env=self.account_env)
            self.client.generate_session()
            logger.info("[ENGINE] %s session established env=%s", client_cls.__name__, self.account_env)
        else:
            if self.account_env != "live":
                logger.warning("[ENGINE] Angel broker only supports live mode; requested env=%s", self.account_env)
            from brokers.angel.trading_client import AngelOneTradingClient
            self.client = AngelOneTradingClient()
            self.client.generate_session()
            logger.info("[ENGINE] AngelOneTradingClient session established")

        self.db_writer = DbEventWriter(db_path="live_events.db")
        self.event_manager = EventManager(self.db_writer)
        status_client = self._create_status_client()
        self.order_manager = OrderManager(client=status_client)
        self.trading_manager = TradingManager(
            self.client, self.event_manager,
            on_event=self._on_engine_event,
            order_manager=self.order_manager,
        )
        self.order_manager.register_listener("trading_manager", self.trading_manager)
        if status_client is not None:
            logger.info("[ENGINE] Portfolio status client wired (%s)", type(status_client).__name__)
        self.tick_provider = TickProvider(
            self.client, interval_seconds=1.0,
            on_tick=self._on_tick
        )
        await self.trading_manager.start()
        await self.order_manager.start()
        await self.tick_provider.start()

        self._broadcast_task = asyncio.create_task(self._broadcast_loop())
        if self.engine_id and self.control_url:
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info(
            "[ENGINE] Live engine started engine_id=%s broker=%s env=%s client_mode=%s fake=%s",
            self.engine_id or "-",
            self.broker,
            self.account_env,
            self.client_mode,
            self.use_fake_client,
        )

    def _create_status_client(self):
        if self.broker != "etoro":
            return None

        from brokers.etoro.status_client import (
            EtoroHybridPortfolioStatusClient,
            EtoroPortfolioStatusClient,
        )

        try:
            return EtoroHybridPortfolioStatusClient(
                poll_interval_seconds=3.0,
                account_env=self.account_env,
            )
        except Exception as e:
            logger.warning(
                "[ENGINE] eToro hybrid status client unavailable (%s); using polling fallback",
                e,
            )
            return EtoroPortfolioStatusClient(interval_seconds=3.0, account_env=self.account_env)

    async def shutdown(self):
        await self._send_heartbeat("stopped")
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        if self.tick_provider:
            await self.tick_provider.stop()
        if self.order_manager:
            await self.order_manager.stop()
        if self.trading_manager:
            await self.trading_manager.stop()
        for executor in self.executors.values():
            await executor.stop()
        if self.event_manager:
            self.event_manager.stop()
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        logger.info("[ENGINE] Live engine shut down")

    def _on_tick(self, tick: TickData):
        tick_key = f"{tick.symbol}:{tick.token}"
        ltp = float(tick.ltp or 0)
        if ltp <= 0:
            logger.warning(
                "[TICK] Ignoring invalid tick symbol=%s token=%s ltp=%s",
                tick.symbol,
                tick.token,
                tick.ltp,
            )
            return

        self._tick_stats["generated"] += 1
        if tick_key not in self._logged_first_ticks:
            self._logged_first_ticks.add(tick_key)
            logger.info(
                "[TICK] First tick symbol=%s token=%s exchange=%s ltp=%s",
                tick.symbol,
                tick.token,
                tick.exchange,
                tick.ltp,
            )

        if self.order_manager and not self.is_bo_client():
            self.order_manager.enqueue_tick(tick)
        msg = {
            'type': 'tick',
            'symbol': tick.symbol,
            'token': tick.token,
            'ltp': tick.ltp,
            'exchange': tick.exchange,
        }
        try:
            self._broadcast_queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass

    def _on_engine_event(self, event: dict):
        try:
            self._broadcast_queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("[WS] Broadcast queue full; dropping event type=%s", event.get("type"))

    def _log_broadcast(self, msg: dict) -> None:
        msg_type = msg.get("type")
        if msg_type == "tick":
            return
        logger.info(
            "[WS] Broadcasting type=%s action=%s executor=%s order=%s event=%s clients=%d",
            msg_type,
            msg.get("action"),
            msg.get("executor_id"),
            msg.get("order_id"),
            msg.get("event_type"),
            len(self.ws_manager.active_connections),
        )

    def _maybe_log_tick_flow(self, now: float) -> None:
        if now - self._last_flow_log_at < 60:
            return
        self._last_flow_log_at = now
        generated = self._tick_stats["generated"]
        broadcast = self._tick_stats["broadcast"]
        logger.info(
            "[TICK] Flow stats generated=%d broadcast=%d ws_clients=%d engine_id=%s",
            generated,
            broadcast,
            len(self.ws_manager.active_connections),
            self.engine_id or "-",
        )
        self._tick_stats = {"generated": 0, "broadcast": 0, "dropped_no_clients": 0}

    async def _broadcast_loop(self):
        import time

        while True:
            msg = await self._broadcast_queue.get()
            client_count = len(self.ws_manager.active_connections)
            if msg.get("type") != "tick":
                self._log_broadcast(msg)
                if client_count:
                    await self.ws_manager.broadcast(msg)
                continue

            if client_count:
                self._tick_stats["broadcast"] += 1
                await self.ws_manager.broadcast(msg)
            else:
                self._tick_stats["dropped_no_clients"] += 1
                now = time.monotonic()
                if now - self._last_no_client_warn_at >= 30:
                    self._last_no_client_warn_at = now
                    dropped = self._tick_stats["dropped_no_clients"]
                    self._tick_stats["dropped_no_clients"] = 0
                    logger.warning(
                        "[TICK] Broker prices flowing but no UI WS clients connected "
                        "symbol=%s token=%s ltp=%s dropped_ticks=%d engine_id=%s",
                        msg.get("symbol"),
                        msg.get("token"),
                        msg.get("ltp"),
                        dropped,
                        self.engine_id or "-",
                    )

            self._maybe_log_tick_flow(time.monotonic())

    def _on_executor_status(self, executor_id: str, status: str, is_in_position: bool):
        msg = {
            'type': 'executor_status',
            'executor_id': executor_id,
            'status': status,
            'is_in_position': is_in_position,
        }
        try:
            self._broadcast_queue.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("[WS] Broadcast queue full; dropping executor_status for %s", executor_id)

    async def _heartbeat_loop(self):
        while True:
            await self._send_heartbeat("running")
            await asyncio.sleep(self.heartbeat_interval)

    async def _send_heartbeat(self, status: str):
        if not (self.engine_id and self.control_url):
            return

        payload = {
            "status": status,
            "pid": os.getpid(),
            "broker": self.broker,
            "account_env": self.account_env,
            "executor_count": len(self.executors),
            "metadata": {
                "symbol": self.symbol,
                "token": self.token,
                "strategy_name": self.strategy_name,
                "use_fake_client": self.use_fake_client,
                "client_mode": self.client_mode,
                "is_bracket_order_client": self.is_bo_client(),
                "ws_connections": len(self.ws_manager.active_connections),
            },
        }
        url = f"{self.control_url}/api/control/engines/{self.engine_id}/heartbeat"
        try:
            await asyncio.to_thread(_post_json, url, payload)
        except Exception as e:
            logger.debug("[ENGINE] Heartbeat failed: %s", e)

    async def register_executor(self, req: "RegisterExecutorRequest") -> dict:
        if req.executor_id in self.executors:
            raise ValueError(f"Executor '{req.executor_id}' already exists")

        config = StrategyConfig(
            long_percent=req.long_percent,
            short_percent=req.short_percent,
            initial_threshold=req.initial_threshold,
            symbol=req.symbol,
            token=req.token,
            exchange=req.exchange,
            max_available_capital=req.max_available_capital,
            allow_partial_stocks=req.allow_partial_stocks,
        )

        executor = StrategyExecutor(
            self.trading_manager, req.executor_id,
            on_status_change=self._on_executor_status
        )
        executor.set_strategy_config(config)
        executor.strategy.initialize_with_close_price(req.close_price)
        executor.is_active = True

        await executor.start()
        self.tick_provider.register_listener(req.token, executor)
        self.executors[req.executor_id] = executor

        self._on_executor_status(req.executor_id, "RUNNING", False)
        logger.info("[ENGINE] Registered executor: %s for %s", req.executor_id, req.symbol)
        return self._executor_state(executor)

    async def remove_executor(self, executor_id: str):
        executor = self.executors.get(executor_id)
        if not executor:
            raise ValueError(f"Executor '{executor_id}' not found")

        token = executor.strategy_config.token if executor.strategy_config else None
        if token:
            self.tick_provider.unregister_listener(token)
        await executor.stop()
        del self.executors[executor_id]

        self._on_executor_status(executor_id, "STOPPED", False)
        logger.info("[ENGINE] Removed executor: %s", executor_id)

    def engine_info(self) -> dict:
        return {
            "id": self.engine_id,
            "broker": self.broker,
            "account_env": self.account_env,
            "use_fake_client": self.use_fake_client,
            "client_mode": self.client_mode,
            "is_bracket_order_client": self.is_bo_client(),
            "executor_count": len(self.executors),
            "symbol": self.symbol,
            "token": self.token,
            "strategy_name": self.strategy_name,
        }

    def is_bo_client(self) -> bool:
        checker = getattr(self.client, "is_bo_client", None)
        return bool(checker()) if callable(checker) else False

    def _executor_state(self, executor: StrategyExecutor) -> dict:
        state = executor.get_state()
        state["broker"] = self.broker
        state["account_env"] = self.account_env
        state["client_mode"] = self.client_mode
        state["is_bracket_order_client"] = self.is_bo_client()
        return state


# ─── Request Models ───────────────────────────────────────────────────────────

class RegisterExecutorRequest(BaseModel):
    executor_id: str
    symbol: str
    token: str
    exchange: str = "NSE"
    long_percent: float = 1.0
    short_percent: float = 10.0
    initial_threshold: float = 0.2
    max_available_capital: float = 100000
    allow_partial_stocks: bool = False
    close_price: float


# ─── App Setup ────────────────────────────────────────────────────────────────

engine: Optional[LiveEngine] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    use_fake = "--fake" in sys.argv
    account_env = _arg_value("--env", os.getenv("BROKER_ENV", "live"))
    engine_id = _arg_value("--engine-id", "")
    load_etoro_env(account_env)
    log_path = live_engine_log_path(engine_id) if engine_id else None
    if log_path:
        logger.info("[ENGINE] Live engine log file path=%s", log_path)
    engine = LiveEngine(
        use_fake_client=use_fake,
        account_env=account_env,
        broker=_arg_value("--broker", "angel"),
        engine_id=engine_id,
        control_url=_arg_value("--control-url", ""),
        heartbeat_interval=float(_arg_value("--heartbeat-interval", "5")),
        symbol=_arg_value("--symbol", ""),
        token=_arg_value("--token", ""),
        strategy_name=_arg_value("--strategy-name", "default"),
        client_mode=_arg_value("--client-mode", "standard"),
    )
    await engine.start()
    yield
    await engine.shutdown()


app = FastAPI(title="Live Trading Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_engine() -> LiveEngine:
    if engine is None:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    return engine


def _arg_value(name: str, default: str) -> str:
    if name not in sys.argv:
        return default
    idx = sys.argv.index(name)
    if idx + 1 >= len(sys.argv):
        return default
    return sys.argv[idx + 1]


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


# ─── REST Endpoints ───────────────────────────────────────────────────────────

@app.get("/api/live/engine-info")
async def get_engine_info():
    return {"status": True, "data": get_engine().engine_info()}

@app.get("/api/live/portfolio")
async def get_portfolio():
    eng = get_engine()
    try:
        if hasattr(eng.client, '_client'):
            raw = eng.client._client.holding()
            if raw and raw.get("data"):
                return {"status": True, "data": raw["data"]}
        # Fake mode: return sample portfolio
        if eng.use_fake_client:
            return {"status": True, "data": [
                {"tradingsymbol": "RELIANCE-EQ", "symboltoken": "2885", "exchange": "NSE", "quantity": "10", "ltp": "1250.00", "averageprice": "1200.00"},
                {"tradingsymbol": "INFY-EQ", "symboltoken": "1594", "exchange": "NSE", "quantity": "25", "ltp": "1450.00", "averageprice": "1400.00"},
                {"tradingsymbol": "TCS-EQ", "symboltoken": "11536", "exchange": "NSE", "quantity": "5", "ltp": "3500.00", "averageprice": "3400.00"},
                {"tradingsymbol": "HDFCBANK-EQ", "symboltoken": "1333", "exchange": "NSE", "quantity": "15", "ltp": "1600.00", "averageprice": "1550.00"},
                {"tradingsymbol": "BAJFINANCE-EQ", "symboltoken": "317", "exchange": "NSE", "quantity": "8", "ltp": "6800.00", "averageprice": "6500.00"},
            ]}
        return {"status": True, "data": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/live/search")
async def search_scrip(q: str, exchange: str = "NSE"):
    eng = get_engine()
    logger.info("[LIVE_SEARCH] request broker=%s env=%s exchange=%s q=%r", eng.broker, eng.account_env, exchange, q)
    try:
        if eng.broker == "etoro" and hasattr(eng.client, "asearch_instruments"):
            instruments = await eng.client.asearch_instruments(q)
            rows = [_etoro_instrument_to_search_row(item) for item in instruments]
            logger.info("[LIVE_SEARCH] etoro returned %d rows for %r", len(rows), q)
            return {"status": True, "data": rows}

        if hasattr(eng.client, '_client'):
            result = eng.client._client.searchScrip(exchange, q)
            if result and result.get("status"):
                rows = result.get("data", []) or []
                logger.info("[LIVE_SEARCH] broker returned %d rows for %r", len(rows), q)
                return {"status": True, "data": rows}
        # Fake mode: return filtered mock results
        if eng.use_fake_client:
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
            filtered = [s for s in mock_stocks if q.upper() in s["tradingsymbol"].upper()]
            logger.info("[LIVE_SEARCH] fake returned %d rows for %r", len(filtered), q)
            return {"status": True, "data": filtered}
        logger.warning("[LIVE_SEARCH] no search backend for broker=%s q=%r", eng.broker, q)
        return {"status": True, "data": []}
    except Exception as e:
        logger.error(
            "[LIVE_SEARCH] failed broker=%s env=%s q=%r status=%s payload=%s error=%s",
            eng.broker,
            eng.account_env,
            q,
            getattr(e, "status_code", None),
            getattr(e, "payload", None),
            e,
            exc_info=True,
        )
        return {"status": False, "data": [], "message": str(e)}


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


@app.post("/api/live/executors")
async def register_executor(req: RegisterExecutorRequest):
    eng = get_engine()
    try:
        state = await eng.register_executor(req)
        logger.info(
            "[ENGINE] Registered executor via API id=%s symbol=%s token=%s",
            req.executor_id,
            req.symbol,
            req.token,
        )
        return {"status": True, "data": state}
    except ValueError as e:
        logger.warning("[ENGINE] Register executor rejected id=%s: %s", req.executor_id, e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("[ENGINE] Register executor failed id=%s: %s", req.executor_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/live/executors/{executor_id}")
async def remove_executor(executor_id: str):
    eng = get_engine()
    try:
        await eng.remove_executor(executor_id)
        return {"status": True, "message": f"Executor '{executor_id}' removed"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/live/executors")
async def list_executors():
    eng = get_engine()
    states = [eng._executor_state(ex) for ex in eng.executors.values()]
    return {"status": True, "data": states}


@app.get("/api/live/orders")
async def get_orders():
    eng = get_engine()
    orders = eng.trading_manager.get_all_orders()
    serializable = {}
    for uid, details in orders.items():
        serializable[uid] = {
            'executor_id': details.get('executor_id'),
            'order_id': details.get('order_id'),
            'unique_order_id': details.get('unique_order_id'),
            'order_type': details.get('order_type'),
            'status': details.get('status'),
        }
    return {"status": True, "data": serializable}


@app.get("/api/live/events")
async def get_events(limit: int = 50, action: Optional[str] = None):
    eng = get_engine()
    events = eng.db_writer.query_events(action=action, limit=limit)
    return {"status": True, "data": events}


@app.get("/api/live/trades")
async def get_trades(executor_id: Optional[str] = None, limit: int = 50):
    eng = get_engine()
    trades = eng.db_writer.query_trading_events(executor_id=executor_id, limit=limit)
    return {"status": True, "data": trades}


@app.get("/api/live/positions")
async def get_positions():
    eng = get_engine()
    positions = eng.db_writer.get_active_positions()
    return {"status": True, "data": positions}


@app.get("/api/live/summary")
async def get_summary():
    eng = get_engine()
    summary = eng.db_writer.get_trading_summary()
    return {"status": True, "data": summary}


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws/live")
async def websocket_live(ws: WebSocket):
    eng = get_engine()
    await eng.ws_manager.connect(ws)

    # Send snapshot on connect
    snapshot = {
        'type': 'snapshot',
        'engine': eng.engine_info(),
        'executors': [eng._executor_state(ex) for ex in eng.executors.values()],
    }
    await ws.send_json(snapshot)

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        eng.ws_manager.disconnect(ws)


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Live Trading Engine Server")
    parser.add_argument("--port", type=int, default=int(os.getenv("LIVE_PORT", "8080")))
    parser.add_argument("--fake", action="store_true", help="Use fake broker for testing")
    parser.add_argument("--env", choices=["demo", "live"], default=os.getenv("BROKER_ENV", "live"), help="Broker account environment")
    parser.add_argument("--engine-id", default="", help="Control-plane engine ID for heartbeat registration")
    parser.add_argument("--control-url", default="", help="Control-plane base URL for heartbeats")
    parser.add_argument("--broker", default="angel", choices=["angel", "etoro", "fake"], help="Broker client to run")
    parser.add_argument("--symbol", default="", help="Execution symbol metadata")
    parser.add_argument("--token", default="", help="Execution token metadata")
    parser.add_argument("--strategy-name", default="default", help="Strategy metadata")
    parser.add_argument("--client-mode", choices=["standard", "bracket"], default="standard", help="Broker client mode")
    parser.add_argument("--heartbeat-interval", type=float, default=5.0, help="Seconds between control-plane heartbeats")
    args = parser.parse_args()

    uvicorn.run(app, host="0.0.0.0", port=args.port)
