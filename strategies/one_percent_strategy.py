from brokers.interfaces import TickData
from utils import order_quantity_from_capital, round_off
from .base import BaseStrategy, TradeSignal


class OnePercentStrategy(BaseStrategy):
    """
    One Percent Strategy - implements the same logic as manual_robo/engine.py
    - Buys when price crosses initial_threshold from last close
    - Sells when price crosses long_percent (take profit) or short_percent (stop loss)
    - Uses 1% profit target by default
    """
    
    def __init__(self, strategy_config):
        super().__init__(strategy_config)
        self.long_percent = getattr(strategy_config, 'long_percent', 1.0)
        self.short_percent = getattr(strategy_config, 'short_percent', 10.0)
        self.initial_threshold = getattr(strategy_config, 'initial_threshold', 0.1)
        self.last_close_price = None
        
    def initialize_with_close_price(self, close_price: float):
        """Initialize strategy with previous close price"""
        self.last_close_price = close_price
        # Create a synthetic tick for the close price
        self.last_tick = TickData(
            symbol=getattr(self.strategy_config, 'symbol', ''),
            token=getattr(self.strategy_config, 'token', ''),
            ltp=close_price,
            exchange=getattr(self.strategy_config, 'exchange', 'NSE')
        )
    
    def provide_signal(self, tick: TickData, available_capital: float = None) -> TradeSignal:
        if self.last_close_price is None:
            return TradeSignal(
                decision="NOTHING",
                reason="No previous close price available"
            )
            
        change_percentage = (round_off((tick.ltp - self.last_close_price) / self.last_close_price)) * 100
        
        if change_percentage >= self.initial_threshold:
            entry_price = tick.ltp
            take_profit_price = round(entry_price * (1 + self.long_percent / 100), 2)
            stop_loss_price = round(entry_price * (1 - self.short_percent / 100), 2)
            # Apply max_available_capital limit if configured
            capital_to_use = available_capital
            if available_capital and hasattr(self.strategy_config, 'max_available_capital') and self.strategy_config.max_available_capital:
                capital_to_use = min(available_capital, self.strategy_config.max_available_capital)
            
            allow_partial = bool(getattr(self.strategy_config, 'allow_partial_stocks', False))
            quantity = order_quantity_from_capital(capital_to_use, entry_price, allow_partial=allow_partial)
            
            reason = f"chg={change_percentage:+.3f}% >= init={self.initial_threshold}% (ref={self.last_close_price})"
            
            self.last_decision = {
                "action": "BUY",
                "pct_change": round(change_percentage, 4),
                "threshold": self.initial_threshold,
                "ref_price": self.last_close_price,
                "close": tick.ltp,
                "reason": reason
            }
            
            return TradeSignal(
                decision="BUY",
                entry_price=entry_price,
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
                quantity=quantity,
                pct_change=round(change_percentage, 4),
                threshold=self.initial_threshold,
                ref_price=self.last_close_price,
                reason=reason
            )
        
        return TradeSignal(
            decision="NOTHING",
            reason=f"chg={change_percentage:+.3f}% < init={self.initial_threshold}% (ref={self.last_close_price})"
        )

