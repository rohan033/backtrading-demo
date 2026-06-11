class StrategyConfig:
    def __init__(
        self,
        long_percent=1,
        short_percent=10,
        stop_loss_amount=None,
        initial_threshold=0.2,
        symbol=None,
        token=None,
        exchange='NSE',
        max_available_capital=None,
        allow_partial_stocks=False,
        tick_sample_every=1,
        strategy_type=None,
        rsi_period=14,
        bb_period=20,
        bb_std=2.0,
        rsi_oversold=30.0,
        instrument_class='equity',
    ) -> None:
        self.long_percent = long_percent
        self.short_percent = short_percent
        self.stop_loss_amount = (
            float(stop_loss_amount)
            if stop_loss_amount is not None and float(stop_loss_amount) > 0
            else None
        )
        self.initial_threshold = initial_threshold
        self.symbol = symbol  # Single symbol
        self.token = token    # Single token
        self.exchange = exchange  # Single exchange
        self.max_available_capital = max_available_capital  # Maximum capital limit for trading
        self.allow_partial_stocks = allow_partial_stocks
        self.tick_sample_every = max(1, int(tick_sample_every or 1))
        self.strategy_type = strategy_type
        self.rsi_period = max(1, int(rsi_period or 14))
        self.bb_period = max(1, int(bb_period or 20))
        self.bb_std = float(bb_std if bb_std is not None else 2.0)
        self.rsi_oversold = float(rsi_oversold if rsi_oversold is not None else 30.0)
        self.instrument_class = (
            'crypto' if str(instrument_class or '').strip().lower() == 'crypto' else 'equity'
        )


class Config:
    def __init__(self, config={}) -> None:
        self.config = config


token_strategies = {}


STRATEGIES = Config()
