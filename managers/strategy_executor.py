from managers.trading_manager import TradingManager
from managers.tick_provider import TickData
from brokers.interfaces import TickListener, Subscription
from strategies import OnePercentStrategy


class StrategyExecutor(TickListener):
    def __init__(self, trading_manager: TradingManager, executor_id: str):
        self.status = "RUNNING"
        self.is_active = False
        self.is_in_position = False
        self.strategy = None
        self.strategy_config = None
        self.trading_manager = trading_manager
        self.executor_id = executor_id
        self._required_subscription: Subscription | None = None

    def set_strategy_config(self, strategy_config):
        self.strategy_config = strategy_config
        self.strategy = OnePercentStrategy(strategy_config)
        self._update_required_subscriptions()

    def _update_required_subscriptions(self):
        self._required_subscription = None
        if self.strategy_config and hasattr(self.strategy_config, 'symbol'):
            self._required_subscription = Subscription(
                exchange=getattr(self.strategy_config, 'exchange', 'NSE'),
                symbol=self.strategy_config.symbol,
                token=self.strategy_config.token
            )

    async def handle_tick(self, tick: TickData):
        if not self.is_active or self.status != "RUNNING":
            return
        if self.strategy is None:
            return
        
        # Check for buy signal - only when not in position
        if not self.is_in_position:
            trade_signal = self.strategy.provide_signal(tick)
            if trade_signal.decision == "BUY":
                res = await self.trading_manager.handle_signal(self.executor_id, trade_signal)
                print(f"BUY signal sent to trading manager: Entry={trade_signal.entry_price}, TP={trade_signal.take_profit_price}, SL={trade_signal.stop_loss_price}, Qty={trade_signal.quantity}")
                print(f"Reason: {trade_signal.reason}")
                if res.has_executed:
                    self.is_in_position = True
                    self.status = "POSITION_OPEN"
                    print(f"Order executed successfully, order_id={res.order_id}")
                return
            else:
                print(f"Signal received but not BUY: {trade_signal.decision}")
                return

    def get_required_subscriptions(self) -> list[Subscription]:
        return [self._required_subscription] if self._required_subscription else []
        