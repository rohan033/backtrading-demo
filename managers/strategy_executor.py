import asyncio
from typing import Callable, Optional

from logzero import logger
from managers.trading_manager import TradingManager
from brokers.interfaces import TickData, TickListener, Subscription
from strategies import OnePercentStrategy

QUEUE_MAX_SIZE = 1000

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


class StrategyExecutor(TickListener):
    def __init__(self, trading_manager: TradingManager, executor_id: str,
                 on_status_change: Optional[Callable[[str, str, bool], None]] = None):
        self.status = "RUNNING"
        self.is_active = False
        self.is_in_position = False
        self.strategy = None
        self.strategy_config = None
        self.trading_manager = trading_manager
        self.executor_id = executor_id
        self._required_subscription: Subscription | None = None
        self._queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=QUEUE_MAX_SIZE)
        self._consumer_task: asyncio.Task | None = None
        self._on_status_change = on_status_change

    def set_strategy_config(self, strategy_config):
        self.strategy_config = strategy_config
        self.strategy = OnePercentStrategy(strategy_config)
        self._update_required_subscriptions()

    def _set_status(self, new_status: str):
        self.status = new_status
        if self._on_status_change:
            try:
                self._on_status_change(self.executor_id, self.status, self.is_in_position)
            except Exception:
                pass

    def get_state(self) -> dict:
        cfg = self.strategy_config
        close_price = None
        if self.strategy and hasattr(self.strategy, 'last_close_price'):
            close_price = self.strategy.last_close_price
        return {
            'executor_id': self.executor_id,
            'status': self.status,
            'is_active': self.is_active,
            'is_in_position': self.is_in_position,
            'symbol': getattr(cfg, 'symbol', None) if cfg else None,
            'token': getattr(cfg, 'token', None) if cfg else None,
            'exchange': getattr(cfg, 'exchange', None) if cfg else None,
            'long_percent': getattr(cfg, 'long_percent', None) if cfg else None,
            'short_percent': getattr(cfg, 'short_percent', None) if cfg else None,
            'initial_threshold': getattr(cfg, 'initial_threshold', None) if cfg else None,
            'max_available_capital': getattr(cfg, 'max_available_capital', None) if cfg else None,
            'allow_partial_stocks': getattr(cfg, 'allow_partial_stocks', False) if cfg else False,
            'close_price': close_price,
        }

    def _update_required_subscriptions(self):
        self._required_subscription = None
        if self.strategy_config and hasattr(self.strategy_config, 'symbol'):
            self._required_subscription = Subscription(
                exchange=getattr(self.strategy_config, 'exchange', 'NSE'),
                symbol=self.strategy_config.symbol,
                token=self.strategy_config.token
            )

    def enqueue_tick(self, tick: TickData):
        try:
            self._queue.put_nowait(tick)
        except asyncio.QueueFull:
            logger.warning("[%s] Queue full, dropping oldest ticks", self.executor_id)
            self._drain_keep_latest(tick)

    def _drain_keep_latest(self, new_tick: TickData):
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        try:
            self._queue.put_nowait(new_tick)
        except asyncio.QueueFull:
            pass

    async def start(self):
        if self._consumer_task is None:
            self._consumer_task = asyncio.create_task(self._consume_loop())
            logger.info("[%s] Consumer loop started", self.executor_id)

    async def stop(self):
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
            self._consumer_task = None
            logger.info("[%s] Consumer loop stopped", self.executor_id)

    async def _consume_loop(self):
        while True:
            tick = await self._queue.get()

            # Drain to latest — only process the most recent tick
            latest = tick
            while not self._queue.empty():
                try:
                    latest = self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

            await self._process_tick(latest)

    async def _process_tick(self, tick: TickData):
        if not self.is_active or self.status != "RUNNING":
            return
        if self.strategy is None:
            return

        if not self.is_in_position:
            available_capital = getattr(self.strategy_config, 'max_available_capital', None)
            trade_signal = self.strategy.provide_signal(tick, available_capital=available_capital)
            if trade_signal.decision == "BUY":
                trade_signal.symbol = tick.symbol
                trade_signal.token = tick.token
                trade_signal.exchange = tick.exchange
                logger.info(
                    "%s[%s]%s %sSIGNAL  BUY%s  %s  ltp=%.2f  chg=%+.3f%%  threshold=%.2f%%",
                    CYAN, self.executor_id, RESET,
                    BOLD + CYAN, RESET,
                    tick.symbol, tick.ltp,
                    trade_signal.pct_change, trade_signal.threshold
                )
                res = await self.trading_manager.handle_signal(self.executor_id, trade_signal)
                if res.has_executed:
                    self.is_in_position = True
                    self._set_status("POSITION_OPEN")
                    logger.info(
                        "%s[%s]%s %sORDER   PLACED%s  order_id=%s  entry=%.2f  TP=%.2f  SL=%.2f  qty=%.2f",
                        CYAN, self.executor_id, RESET,
                        BOLD + GREEN, RESET,
                        res.order_id,
                        trade_signal.entry_price, trade_signal.take_profit_price,
                        trade_signal.stop_loss_price, trade_signal.quantity
                    )
                else:
                    logger.warning(
                        "%s[%s]%s %sORDER   FAILED%s  %s",
                        CYAN, self.executor_id, RESET,
                        BOLD + RED, RESET,
                        res.error_message
                    )
            else:
                logger.debug(
                    "%s[%s]%s %sTICK%s    %s  ltp=%.2f  chg=%+.3f%%",
                    DIM, self.executor_id, RESET,
                    DIM, RESET,
                    tick.symbol, tick.ltp, trade_signal.pct_change
                )

    # TickListener protocol — kept for interface compatibility
    async def handle_tick(self, tick: TickData):
        self.enqueue_tick(tick)

    def get_required_subscriptions(self) -> list[Subscription]:
        return [self._required_subscription] if self._required_subscription else []
