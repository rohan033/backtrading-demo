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

from client import TotpClient
from strategy import Strategy
from backtesting import Backtesting
from api.manual_robo_routes import router as manual_robo_router
from control_plane.engine_registry import EngineRegistry
from control_plane.engine_process_manager import EngineProcessManager

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

# ── Global client ──
_client: Optional[TotpClient] = None
_portfolio_cache = None
_portfolio_cache_time = 0
PORTFOLIO_CACHE_TTL = 60  # seconds


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


@app.post("/api/control/executions")
def create_controlled_execution(req: ControlPlaneExecutionRequest):
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
    try:
        engine = engine_process_manager.start_engine(
            {
                "broker": "fake" if req.use_fake_client else req.broker,
                "account_env": req.account_env,
                "strategy_name": req.strategy_name,
                "client_mode": "bracket" if req.client_mode == "bracket" else "standard",
                "symbol": req.symbol,
                "token": req.token,
                "label": f"{req.broker}-{req.symbol}-strategy-{req.strategy_name}",
                "use_fake_client": req.use_fake_client,
                "metadata": {
                    "executor_payload": executor_payload,
                    "exchange": req.exchange,
                    "client_mode": req.client_mode,
                },
            }
        )
    except Exception as e:
        log.error("[CONTROL] Failed to start data-plane engine: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": True, "data": {"engine": engine, "executor": executor_payload}}


def _execution_id(broker: str, symbol: str, strategy_name: str) -> str:
    raw = f"{broker}-{symbol}-strategy-{strategy_name}".lower()
    return "".join(ch if ch.isalnum() else "-" for ch in raw).strip("-")

@app.get("/api/portfolio")
def get_portfolio():
    import time as _time
    global _portfolio_cache, _portfolio_cache_time
    try:
        now = _time.time()
        if _portfolio_cache and (now - _portfolio_cache_time) < PORTFOLIO_CACHE_TTL:
            log.info("[PORTFOLIO] Serving from cache (%d holdings)", len(_portfolio_cache))
            return {"status": True, "data": _portfolio_cache}
        log.info("[PORTFOLIO] Fetching fresh holdings from API...")
        client = get_client()
        raw = client._client.holding()["data"]
        _portfolio_cache = raw
        _portfolio_cache_time = now
        log.info("[PORTFOLIO] Fetched %d holdings", len(raw))
        for h in raw:
            log.info("  -> %s  qty=%s  ltp=%s", h.get('tradingsymbol'), h.get('quantity'), h.get('ltp'))
        return {"status": True, "data": raw}
    except Exception as e:
        log.error("[PORTFOLIO] Error: %s", e)
        if _portfolio_cache:
            log.info("[PORTFOLIO] Returning stale cache (%d holdings)", len(_portfolio_cache))
            return {"status": True, "data": _portfolio_cache}
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
