from abc import ABC, abstractmethod
from dataclasses import dataclass
from managers.tick_provider import TickData


@dataclass
class TradeSignal:
    decision: str  # "BUY" or "SELL" or "NOTHING"
    entry_price: float  
    take_profit_price: float
    stop_loss_price: float
    quantity: int
    pct_change: float
    threshold: float
    ref_price: float
    reason: str


class BaseStrategy(ABC):
    """Base class for all trading strategies"""
    
    def __init__(self, strategy_config):
        self.strategy_config = strategy_config
        self.last_tick = None
        self.last_decision = None
    
    @abstractmethod
    def provide_signal(self, tick: TickData, available_capital: float = None) -> 'TradeSignal':
        """Determine if strategy should trigger a buy signal based on trading logic"""
        pass
