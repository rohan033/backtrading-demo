class StrategyConfig:
    def __init__(self, long_percent=1, short_percent=10, initial_threshold=0.2) -> None:
        self.long_percent = long_percent
        self.short_percent = short_percent
        self.initial_threshold = initial_threshold


class Config:
    def __init__(self, config={}) -> None:
        self.config = config


token_strategies = {}


STRATEGIES = Config()
