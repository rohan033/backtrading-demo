class StrategyConfig:
    def __init__(
        self,
        long_percent=1,
        short_percent=10,
        initial_threshold=0.2,
        symbol=None,
        token=None,
        exchange='NSE',
        max_available_capital=None,
        allow_partial_stocks=False,
        tick_sample_every=1,
    ) -> None:
        self.long_percent = long_percent
        self.short_percent = short_percent
        self.initial_threshold = initial_threshold
        self.symbol = symbol  # Single symbol
        self.token = token    # Single token
        self.exchange = exchange  # Single exchange
        self.max_available_capital = max_available_capital  # Maximum capital limit for trading
        self.allow_partial_stocks = allow_partial_stocks
        self.tick_sample_every = max(1, int(tick_sample_every or 1))


class Config:
    def __init__(self, config={}) -> None:
        self.config = config


token_strategies = {}


STRATEGIES = Config()
