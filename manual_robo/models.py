from pydantic import BaseModel
from typing import Optional


class StartRoboRequest(BaseModel):
    symbol: str
    token: str
    exchange: str = "NSE"
    long_percent: float = 0.5
    short_percent: float = 10.0
    initial_threshold: float = 0.1
    configured_capital: float = 100000
    daily_profit_target_pct: float = 1.0
    closing_start: str  # e.g. "2026-05-14 15:29"
    closing_end: str    # e.g. "2026-05-14 15:30"


class StopRoboRequest(BaseModel):
    session_id: int
