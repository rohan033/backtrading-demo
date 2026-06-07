from brokers.etoro.order_helpers import compute_stop_loss_price
from brokers.interfaces import TickData
from indicators.streaming import IndicatorSnapshot, StreamingIndicators
from utils import order_quantity_from_capital
from .base import BaseStrategy, TradeSignal


class RsiBollingerStrategy(BaseStrategy):
    """
    Mean-reversion entry on live tick stream:
    - BUY when RSI <= oversold and LTP at or below the lower Bollinger band
    - TP/SL from long_percent / short_percent (same as one-percent strategy)
    """

    def __init__(self, strategy_config):
        super().__init__(strategy_config)
        self.long_percent = getattr(strategy_config, "long_percent", 1.0)
        self.short_percent = getattr(strategy_config, "short_percent", 10.0)
        self.stop_loss_amount = getattr(strategy_config, "stop_loss_amount", None)
        self.rsi_period = getattr(strategy_config, "rsi_period", 14)
        self.bb_period = getattr(strategy_config, "bb_period", 20)
        self.bb_std = getattr(strategy_config, "bb_std", 2.0)
        self.rsi_oversold = getattr(strategy_config, "rsi_oversold", 30.0)
        self._indicators = StreamingIndicators(
            rsi_period=self.rsi_period,
            bb_period=self.bb_period,
            bb_std=self.bb_std,
        )
        self.last_snapshot: IndicatorSnapshot | None = None
        self.last_close_price = None

    def initialize_with_close_price(self, close_price: float):
        self.last_close_price = close_price
        self.last_snapshot = self._indicators.seed(close_price)
        self.last_tick = TickData(
            symbol=getattr(self.strategy_config, "symbol", ""),
            token=getattr(self.strategy_config, "token", ""),
            ltp=close_price,
            exchange=getattr(self.strategy_config, "exchange", "NSE"),
        )

    def provide_signal(self, tick: TickData, available_capital: float = None) -> TradeSignal:
        snap = self._indicators.update(tick.ltp)
        self.last_snapshot = snap

        if not snap.ready:
            return TradeSignal(
                decision="NOTHING",
                reason=f"Warming up indicators ({snap.price_count} prices)",
            )

        below_lower = tick.ltp <= snap.bb_lower
        oversold = snap.rsi <= self.rsi_oversold

        if not (below_lower and oversold):
            return TradeSignal(
                decision="NOTHING",
                reason=(
                    f"rsi={snap.rsi:.1f} bb_lower={snap.bb_lower:.2f} ltp={tick.ltp:.2f} "
                    f"(need rsi<={self.rsi_oversold:.0f} and ltp<=lower)"
                ),
            )

        entry_price = tick.ltp
        take_profit_price = round(entry_price * (1 + self.long_percent / 100), 2)

        capital_to_use = available_capital
        if (
            available_capital
            and hasattr(self.strategy_config, "max_available_capital")
            and self.strategy_config.max_available_capital
        ):
            capital_to_use = min(available_capital, self.strategy_config.max_available_capital)
        stop_loss_price = compute_stop_loss_price(
            entry_price,
            capital_to_use,
            stop_loss_amount=self.stop_loss_amount,
            short_percent=self.short_percent,
        )

        allow_partial = bool(getattr(self.strategy_config, "allow_partial_stocks", False))
        quantity = order_quantity_from_capital(
            capital_to_use, entry_price, allow_partial=allow_partial
        )

        reason = (
            f"rsi={snap.rsi:.1f}<={self.rsi_oversold:.0f} "
            f"ltp={tick.ltp:.2f}<=bb_lower={snap.bb_lower:.2f}"
        )
        self.last_decision = {
            "action": "BUY",
            "rsi": snap.rsi,
            "bb_lower": snap.bb_lower,
            "close": tick.ltp,
            "reason": reason,
        }

        return TradeSignal(
            decision="BUY",
            entry_price=entry_price,
            take_profit_price=take_profit_price,
            stop_loss_price=stop_loss_price,
            quantity=quantity,
            reason=reason,
        )
