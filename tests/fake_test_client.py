"""
Fake testing client that simulates the full trading workflow end-to-end
without needing a real broker connection.

Components mocked:
- FakeTradingClient: replaces AngelOneTradingClient (simulates LTP responses + order placement)
- FakeTickGenerator: generates synthetic price ticks with configurable patterns
- Orchestrator: wires everything together and runs the system

Usage:
    python -m tests.fake_test_client
"""

import asyncio
import random
import sys
import os
import time
import uuid
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logzero
from logzero import logger

logzero.loglevel(logzero.INFO)

from brokers.interfaces import TickClient, Subscription, LTPData
from managers.tick_provider import TickProvider
from event.db_event_consumer import DbEventWriter
from event.event_manager import create_event_manager
from managers.trading_manager import TradingManager
from managers.strategy_executor import StrategyExecutor
from strategy_config import StrategyConfig

# ANSI color codes
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


# ─── Fake Broker Client ───────────────────────────────────────────────────────

class FakeTradingClient(TickClient):
    def __init__(self, tick_generator: "FakeTickGenerator"):
        self._tick_generator = tick_generator
        self._orders_placed = []
        self._order_counter = 0
        self._should_fail_orders = False

    def is_bo_client(self) -> bool:
        return False

    async def aget_ltp_bulk(self, subscriptions: list[Subscription]) -> list[LTPData]:
        results = []
        for sub in subscriptions:
            price = self._tick_generator.next_price(sub.token)
            results.append(LTPData(
                exchange=sub.exchange,
                symbol=sub.symbol,
                token=sub.token,
                ltp=price
            ))
        return results

    async def abuy(self, ltp, available_capital, symbol, token, exchange,
                   variety="NORMAL", orderType="LIMIT", productType="DELIVERY",
                   duration="DAY"):
        if self._should_fail_orders:
            logger.warning(
                "%s[BROKER]%s %sREJECTED%s  %s  ltp=%.2f",
                YELLOW, RESET, BOLD + RED, RESET, symbol, ltp
            )
            return {}

        self._order_counter += 1
        order_id = f"FAKE-{self._order_counter:04d}"
        unique_order_id = str(uuid.uuid4())[:8]

        quantity = round(available_capital / ltp, 2)
        if quantity <= 0:
            logger.warning("Capital %.2f too low for LTP=%.2f", available_capital, ltp)
            return {}

        self._orders_placed.append({
            "order_id": order_id,
            "unique_order_id": unique_order_id,
            "symbol": symbol,
            "token": token,
            "exchange": exchange,
            "ltp": ltp,
            "quantity": quantity,
            "type": "BUY",
            "timestamp": time.time()
        })

        logger.info(
            "%s[BROKER]%s %sFILLED%s   %s  qty=%.2f  price=%.2f  order_id=%s",
            YELLOW, RESET, BOLD + GREEN, RESET,
            symbol, quantity, ltp, order_id
        )

        return {"order_id": order_id, "unique_order_id": unique_order_id}

    async def asell(self, ltp, quantity, symbol, token, exchange,
                    variety="NORMAL", orderType="MARKET", productType="DELIVERY",
                    duration="DAY"):
        self._order_counter += 1
        order_id = f"FAKE-{self._order_counter:04d}"
        unique_order_id = str(uuid.uuid4())[:8]
        self._orders_placed.append({
            "order_id": order_id,
            "unique_order_id": unique_order_id,
            "symbol": symbol,
            "token": token,
            "exchange": exchange,
            "ltp": ltp,
            "quantity": quantity,
            "type": "SELL",
            "timestamp": time.time()
        })
        logger.info(
            "%s[BROKER]%s %sEXIT%s     %s  qty=%s  price=%.2f  order_id=%s",
            YELLOW, RESET, BOLD + GREEN, RESET,
            symbol, quantity, ltp, order_id
        )
        return {"order_id": order_id, "unique_order_id": unique_order_id}

    def set_fail_orders(self, should_fail: bool):
        self._should_fail_orders = should_fail

    def get_placed_orders(self):
        return self._orders_placed.copy()


# ─── Fake Tick Generator ──────────────────────────────────────────────────────

class FakeTickGenerator:
    """
    Generates synthetic price data.

    Modes: trending_up, trending_down, volatile, flat, spike
    """

    def __init__(self, base_price: float = 1000.0, mode: str = "trending_up"):
        self._base_price = base_price
        self._mode = mode
        self._tick_count = 0
        self._current_prices = {}

    def set_mode(self, mode: str):
        self._mode = mode

    def next_price(self, token: str) -> float:
        self._tick_count += 1

        if token not in self._current_prices:
            self._current_prices[token] = self._base_price

        current = self._current_prices[token]

        if self._mode == "trending_up":
            new_price = current + random.uniform(0.05, 0.3)
        elif self._mode == "trending_down":
            new_price = current - random.uniform(0.05, 0.3)
        elif self._mode == "volatile":
            new_price = current + random.uniform(-2.0, 2.0)
        elif self._mode == "flat":
            new_price = current + random.uniform(-0.02, 0.02)
        elif self._mode == "spike":
            if self._tick_count % 10 == 0:
                new_price = current * 1.005
            else:
                new_price = current + random.uniform(-0.1, 0.1)
        else:
            new_price = current

        new_price = round(max(new_price, 1.0), 2)
        self._current_prices[token] = new_price
        return new_price

    def get_current_price(self, token: str) -> float:
        return self._current_prices.get(token, self._base_price)

    def reset(self):
        self._tick_count = 0
        self._current_prices = {}


# ─── Test Orchestrator ────────────────────────────────────────────────────────

class TestOrchestrator:
    def __init__(self,
                 base_price: float = 1000.0,
                 tick_mode: str = "trending_up",
                 poll_interval: float = 0.5,
                 db_path: str = "test_event_logs.db"):

        self.tick_generator = FakeTickGenerator(base_price=base_price, mode=tick_mode)
        self.fake_client = FakeTradingClient(self.tick_generator)
        self.db_writer = DbEventWriter(db_path=db_path)
        self.event_manager = create_event_manager(self.db_writer)
        self.trading_manager = TradingManager(self.fake_client, self.event_manager)
        self.tick_provider = TickProvider(self.fake_client, interval_seconds=poll_interval)
        self.executors: dict[str, StrategyExecutor] = {}
        self._tick_mode = tick_mode
        self._base_price = base_price

    def add_executor(self, executor_id: str, symbol: str, token: str,
                     exchange: str = "NSE",
                     long_percent: float = 1.0,
                     short_percent: float = 10.0,
                     initial_threshold: float = 0.2,
                     max_capital: float = 50000.0,
                     close_price: Optional[float] = None):

        config = StrategyConfig(
            long_percent=long_percent,
            short_percent=short_percent,
            initial_threshold=initial_threshold,
            symbol=symbol,
            token=token,
            exchange=exchange,
            max_available_capital=max_capital
        )

        executor = StrategyExecutor(self.trading_manager, executor_id)
        executor.set_strategy_config(config)
        executor.is_active = True

        ref_price = close_price or self.tick_generator.get_current_price(token)
        executor.strategy.initialize_with_close_price(ref_price)

        self.tick_provider.register_listener(token, executor)
        self.executors[executor_id] = executor

    async def run(self, duration_seconds: float = 10.0):
        for executor in self.executors.values():
            await executor.start()
        await self.tick_provider.start()
        try:
            await asyncio.sleep(duration_seconds)
        except asyncio.CancelledError:
            pass
        await self.tick_provider.stop()
        for executor in self.executors.values():
            await executor.stop()
        self.event_manager.stop()

    def log_summary(self):
        orders = self.fake_client.get_placed_orders()
        trading_events = self.db_writer.query_trading_events(limit=50)
        positions = self.db_writer.get_active_positions()

        logger.info("[SUMMARY] Orders: %d  |  DB events: %d  |  Active positions: %d",
                    len(orders), len(trading_events), len(positions))
        for eid, executor in self.executors.items():
            state = "IN_POSITION" if executor.is_in_position else "WATCHING"
            logger.info("[SUMMARY] %s -> %s", eid, state)


# ─── Preset Test Scenarios ────────────────────────────────────────────────────

async def test_scenario_basic_buy():
    logger.info("")
    logger.info("=" * 64)
    logger.info("[SCENARIO 1] Basic Buy Signal")
    logger.info("  Price trends up from 1000, crosses 0.2%% threshold")
    logger.info("  Expected: BUY order fires")
    logger.info("=" * 64)
    logger.info("")

    orch = TestOrchestrator(
        base_price=1000.0, tick_mode="trending_up",
        poll_interval=0.3, db_path="test_basic_buy.db"
    )
    orch.add_executor(
        executor_id="exec-1", symbol="RELIANCE-EQ", token="2885",
        close_price=1000.0, initial_threshold=0.2, max_capital=50000.0
    )
    await orch.run(duration_seconds=6)

    logger.info("")
    orch.log_summary()
    passed = len(orch.fake_client.get_placed_orders()) > 0
    return passed


async def test_scenario_no_signal():
    logger.info("")
    logger.info("=" * 64)
    logger.info("[SCENARIO 2] No Signal (flat market)")
    logger.info("  Price stays flat, no threshold crossed")
    logger.info("  Expected: No orders placed")
    logger.info("=" * 64)
    logger.info("")

    orch = TestOrchestrator(
        base_price=500.0, tick_mode="flat",
        poll_interval=0.3, db_path="test_no_signal.db"
    )
    orch.add_executor(
        executor_id="exec-flat", symbol="INFY-EQ", token="1594",
        close_price=500.0, initial_threshold=0.2, max_capital=30000.0
    )
    await orch.run(duration_seconds=4)

    logger.info("")
    orch.log_summary()
    passed = len(orch.fake_client.get_placed_orders()) == 0
    return passed


async def test_scenario_multiple_executors():
    logger.info("")
    logger.info("=" * 64)
    logger.info("[SCENARIO 3] Multiple Executors")
    logger.info("  Two executors: threshold=0.2%% and threshold=0.3%%")
    logger.info("  Expected: Both trigger BUY (lower threshold first)")
    logger.info("=" * 64)
    logger.info("")

    orch = TestOrchestrator(
        base_price=1500.0, tick_mode="trending_up",
        poll_interval=0.3, db_path="test_multi_exec.db"
    )
    orch.add_executor(
        executor_id="exec-reliance", symbol="RELIANCE-EQ", token="2885",
        close_price=1500.0, initial_threshold=0.2, max_capital=50000.0
    )
    orch.add_executor(
        executor_id="exec-tcs", symbol="TCS-EQ", token="11536",
        close_price=1500.0, initial_threshold=0.3, max_capital=40000.0
    )
    await orch.run(duration_seconds=12)

    logger.info("")
    orch.log_summary()
    passed = len(orch.fake_client.get_placed_orders()) >= 2
    return passed


async def test_scenario_order_failure():
    logger.info("")
    logger.info("=" * 64)
    logger.info("[SCENARIO 4] Order Failure")
    logger.info("  Broker rejects all orders")
    logger.info("  Expected: Executor never enters position")
    logger.info("=" * 64)
    logger.info("")

    orch = TestOrchestrator(
        base_price=800.0, tick_mode="trending_up",
        poll_interval=0.3, db_path="test_order_fail.db"
    )
    orch.fake_client.set_fail_orders(True)
    orch.add_executor(
        executor_id="exec-fail", symbol="HDFCBANK-EQ", token="1333",
        close_price=800.0, initial_threshold=0.1, max_capital=25000.0
    )
    await orch.run(duration_seconds=4)

    logger.info("")
    orch.log_summary()
    orders = orch.fake_client.get_placed_orders()
    in_pos = orch.executors["exec-fail"].is_in_position
    passed = len(orders) == 0 and not in_pos
    return passed


async def test_scenario_spike():
    logger.info("")
    logger.info("=" * 64)
    logger.info("[SCENARIO 5] Price Spike Detection")
    logger.info("  Periodic 0.5%% spikes, threshold=0.3%%")
    logger.info("  Expected: BUY triggers on spike")
    logger.info("=" * 64)
    logger.info("")

    orch = TestOrchestrator(
        base_price=2000.0, tick_mode="spike",
        poll_interval=0.2, db_path="test_spike.db"
    )
    orch.add_executor(
        executor_id="exec-spike", symbol="BAJFINANCE-EQ", token="317",
        close_price=2000.0, initial_threshold=0.3, max_capital=60000.0
    )
    await orch.run(duration_seconds=6)

    logger.info("")
    orch.log_summary()
    passed = len(orch.fake_client.get_placed_orders()) > 0
    return passed


# ─── Main ─────────────────────────────────────────────────────────────────────

async def run_all_scenarios():
    scenarios = [
        ("Basic Buy Signal", test_scenario_basic_buy),
        ("No Signal (flat)", test_scenario_no_signal),
        ("Multiple Executors", test_scenario_multiple_executors),
        ("Order Failure", test_scenario_order_failure),
        ("Price Spike", test_scenario_spike),
    ]

    logger.info("=" * 64)
    logger.info("  BACKTRADING SYSTEM - INTEGRATION TEST")
    logger.info("=" * 64)
    logger.info("")
    logger.info("  Workflow:")
    logger.info("    TickGenerator -> FakeClient -> TickProvider")
    logger.info("      -> StrategyExecutor (queue) -> TradingManager")
    logger.info("      -> EventManager -> DbEventWriter (SQLite)")
    logger.info("")

    results = []
    for name, fn in scenarios:
        passed = await fn()
        results.append((name, passed))

    logger.info("")
    logger.info("=" * 64)
    logger.info("  RESULTS")
    logger.info("=" * 64)
    logger.info("")
    for name, passed in results:
        if passed:
            logger.info("  [PASS] %s", name)
        else:
            logger.error("  [FAIL] %s", name)

    total = len(results)
    passed_count = sum(1 for _, p in results if p)
    logger.info("")
    logger.info("  %d/%d scenarios passed", passed_count, total)
    logger.info("")

    # Cleanup test DBs
    for f in ["test_basic_buy.db", "test_no_signal.db", "test_multi_exec.db",
              "test_order_fail.db", "test_spike.db"]:
        if os.path.exists(f):
            os.remove(f)


if __name__ == "__main__":
    asyncio.run(run_all_scenarios())
