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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from logzero import logger
from pydantic import BaseModel

from brokers.interfaces import TickData
from brokers.etoro.env import load_etoro_env
from event.db_event_consumer import DbEventWriter
from event.event_manager import EventManager
from managers.strategy_executor import StrategyExecutor
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
        logger.info("[WS] Client connected (%d total)", len(self.active_connections))

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
    def __init__(self, use_fake_client: bool = False, account_env: str = "live"):
        self.use_fake_client = use_fake_client
        self.account_env = "demo" if account_env == "demo" else "live"
        self.broker = "fake" if use_fake_client else "angel"
        self.client = None
        self.db_writer: Optional[DbEventWriter] = None
        self.event_manager: Optional[EventManager] = None
        self.trading_manager: Optional[TradingManager] = None
        self.tick_provider: Optional[TickProvider] = None
        self.executors: dict[str, StrategyExecutor] = {}
        self.ws_manager = ConnectionManager()
        self._broadcast_queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._broadcast_task: Optional[asyncio.Task] = None

    async def start(self):
        if self.use_fake_client:
            from tests.fake_test_client import FakeTradingClient, FakeTickGenerator
            tick_gen = FakeTickGenerator(base_price=1000.0, mode="trending_up")
            self.client = FakeTradingClient(tick_gen)
            logger.info("[ENGINE] Using FakeTradingClient (test mode)")
        else:
            if self.account_env != "live":
                logger.warning("[ENGINE] Angel broker only supports live mode; requested env=%s", self.account_env)
            from brokers.angel.trading_client import AngelOneTradingClient
            self.client = AngelOneTradingClient()
            self.client.generate_session()
            logger.info("[ENGINE] AngelOneTradingClient session established")

        self.db_writer = DbEventWriter(db_path="live_events.db")
        self.event_manager = EventManager(self.db_writer)
        self.trading_manager = TradingManager(
            self.client, self.event_manager,
            on_event=self._on_engine_event
        )
        self.tick_provider = TickProvider(
            self.client, interval_seconds=1.0,
            on_tick=self._on_tick
        )
        await self.tick_provider.start()

        self._broadcast_task = asyncio.create_task(self._broadcast_loop())
        logger.info("[ENGINE] Live engine started broker=%s env=%s", self.broker, self.account_env)

    async def shutdown(self):
        await self.tick_provider.stop()
        for executor in self.executors.values():
            await executor.stop()
        self.event_manager.stop()
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        logger.info("[ENGINE] Live engine shut down")

    def _on_tick(self, tick: TickData):
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
            pass

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
            pass

    async def _broadcast_loop(self):
        while True:
            msg = await self._broadcast_queue.get()
            if self.ws_manager.active_connections:
                await self.ws_manager.broadcast(msg)

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
            "broker": self.broker,
            "account_env": self.account_env,
            "use_fake_client": self.use_fake_client,
            "executor_count": len(self.executors),
        }

    def _executor_state(self, executor: StrategyExecutor) -> dict:
        state = executor.get_state()
        state["broker"] = self.broker
        state["account_env"] = self.account_env
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
    close_price: float


# ─── App Setup ────────────────────────────────────────────────────────────────

engine: Optional[LiveEngine] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    use_fake = "--fake" in sys.argv
    account_env = _arg_value("--env", os.getenv("BROKER_ENV", "live"))
    load_etoro_env(account_env)
    engine = LiveEngine(use_fake_client=use_fake, account_env=account_env)
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
    try:
        if hasattr(eng.client, '_client'):
            result = eng.client._client.searchScrip(exchange, q)
            if result and result.get("status"):
                return {"status": True, "data": result.get("data", [])}
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
            return {"status": True, "data": filtered}
        return {"status": True, "data": []}
    except Exception as e:
        return {"status": False, "data": [], "message": str(e)}


@app.post("/api/live/executors")
async def register_executor(req: RegisterExecutorRequest):
    eng = get_engine()
    try:
        state = await eng.register_executor(req)
        return {"status": True, "data": state}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
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
    args = parser.parse_args()

    uvicorn.run(app, host="0.0.0.0", port=args.port)
