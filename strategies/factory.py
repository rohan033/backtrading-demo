from strategy_config import StrategyConfig

from .base import BaseStrategy
from .one_percent_strategy import OnePercentStrategy
from .rsi_bollinger_strategy import RsiBollingerStrategy

RSI_BOLLINGER_ALIASES = frozenset({"rsi-bollinger", "rsi_bollinger", "rsibollinger"})


def create_strategy(strategy_config: StrategyConfig) -> BaseStrategy:
    kind = (
        getattr(strategy_config, "strategy_type", None)
        or getattr(strategy_config, "strategy_name", None)
        or "one-percent"
    )  # strategy_name from control plane maps to template id (e.g. rsi-bollinger)
    key = str(kind).strip().lower()
    if key in RSI_BOLLINGER_ALIASES:
        return RsiBollingerStrategy(strategy_config)
    return OnePercentStrategy(strategy_config)
