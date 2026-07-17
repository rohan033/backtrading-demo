"""Curated TradingView stock screener field catalog.

Field keys match https://shner-elmo.github.io/TradingView-Screener/fields/stocks.html
"""

from __future__ import annotations

from typing import Any

# Common operators usable in the visual filter builder.
OPS_NUMBER = [
    {"id": "greater", "label": ">"},
    {"id": "egreater", "label": ">="},
    {"id": "less", "label": "<"},
    {"id": "eless", "label": "<="},
    {"id": "equal", "label": "="},
    {"id": "nequal", "label": "!="},
    {"id": "in_range", "label": "between"},
    {"id": "not_in_range", "label": "not between"},
    {"id": "nempty", "label": "not empty"},
    {"id": "empty", "label": "empty"},
]

OPS_PERCENT = OPS_NUMBER
OPS_PRICE = OPS_NUMBER
OPS_TEXT = [
    {"id": "equal", "label": "="},
    {"id": "nequal", "label": "!="},
    {"id": "match", "label": "contains"},
    {"id": "nmatch", "label": "not contains"},
    {"id": "in_range", "label": "in"},
    {"id": "not_in_range", "label": "not in"},
    {"id": "nempty", "label": "not empty"},
    {"id": "empty", "label": "empty"},
]
OPS_BOOL = [
    {"id": "equal", "label": "="},
    {"id": "nequal", "label": "!="},
]
OPS_SET = [
    {"id": "has", "label": "has"},
    {"id": "has_none_of", "label": "has none of"},
    {"id": "in_range", "label": "in"},
    {"id": "not_in_range", "label": "not in"},
]

SCREENER_FIELDS: list[dict[str, Any]] = [
    {"key": "name", "label": "Symbol", "type": "text", "ops": OPS_TEXT},
    {"key": "description", "label": "Description", "type": "text", "ops": OPS_TEXT},
    {"key": "close", "label": "Price", "type": "price", "ops": OPS_PRICE},
    {"key": "change", "label": "Chg %", "type": "percent", "ops": OPS_PERCENT},
    {"key": "change_abs", "label": "Change", "type": "price", "ops": OPS_PRICE},
    {"key": "volume", "label": "Vol", "type": "number", "ops": OPS_NUMBER},
    {"key": "relative_volume_10d_calc", "label": "Relative Volume", "type": "number", "ops": OPS_NUMBER},
    {"key": "market_cap_basic", "label": "Mkt cap", "type": "number", "ops": OPS_NUMBER},
    {"key": "Perf.1Y.MarketCap", "label": "Mkt cap perf % 1Y", "type": "percent", "ops": OPS_PERCENT},
    {"key": "premarket_change", "label": "Pre-mkt chg %", "type": "percent", "ops": OPS_PERCENT},
    {"key": "premarket_change_abs", "label": "Pre-mkt chg", "type": "price", "ops": OPS_PRICE},
    {"key": "premarket_gap", "label": "Pre-mkt gap %", "type": "percent", "ops": OPS_PERCENT},
    {"key": "premarket_volume", "label": "Pre-mkt vol", "type": "number", "ops": OPS_NUMBER},
    {"key": "premarket_close", "label": "Pre-mkt price", "type": "price", "ops": OPS_PRICE},
    {"key": "postmarket_change", "label": "Post-market Change %", "type": "percent", "ops": OPS_PERCENT},
    {"key": "postmarket_volume", "label": "Post-market Volume", "type": "number", "ops": OPS_NUMBER},
    {"key": "gap", "label": "Gap %", "type": "percent", "ops": OPS_PERCENT},
    {"key": "open", "label": "Open", "type": "price", "ops": OPS_PRICE},
    {"key": "high", "label": "High", "type": "price", "ops": OPS_PRICE},
    {"key": "low", "label": "Low", "type": "price", "ops": OPS_PRICE},
    {"key": "price_52_week_high", "label": "52W High", "type": "price", "ops": OPS_PRICE},
    {"key": "price_52_week_low", "label": "52W Low", "type": "price", "ops": OPS_PRICE},
    {"key": "average_volume_10d_calc", "label": "Avg Volume (10d)", "type": "number", "ops": OPS_NUMBER},
    {"key": "average_volume_30d_calc", "label": "Avg Volume (30d)", "type": "number", "ops": OPS_NUMBER},
    {"key": "Value.Traded", "label": "Value Traded", "type": "number", "ops": OPS_NUMBER},
    {"key": "sector", "label": "Sector", "type": "text", "ops": OPS_TEXT},
    {"key": "industry", "label": "Industry", "type": "text", "ops": OPS_TEXT},
    {"key": "exchange", "label": "Exchange", "type": "text", "ops": OPS_TEXT},
    {"key": "type", "label": "Type", "type": "text", "ops": OPS_TEXT},
    {"key": "typespecs", "label": "Type Specs", "type": "set", "ops": OPS_SET},
    {"key": "is_primary", "label": "Primary Listing", "type": "bool", "ops": OPS_BOOL},
    {"key": "price_earnings_ttm", "label": "P/E (TTM)", "type": "number", "ops": OPS_NUMBER},
    {"key": "earnings_per_share_diluted_ttm", "label": "EPS (TTM)", "type": "number", "ops": OPS_NUMBER},
    {"key": "dividends_yield_current", "label": "Dividend Yield", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Recommend.All", "label": "Technical Rating", "type": "number", "ops": OPS_NUMBER},
    {"key": "RSI", "label": "RSI", "type": "number", "ops": OPS_NUMBER},
    {"key": "SMA20", "label": "SMA 20", "type": "price", "ops": OPS_PRICE},
    {"key": "SMA50", "label": "SMA 50", "type": "price", "ops": OPS_PRICE},
    {"key": "SMA200", "label": "SMA 200", "type": "price", "ops": OPS_PRICE},
    {"key": "EMA20", "label": "EMA 20", "type": "price", "ops": OPS_PRICE},
    {"key": "EMA50", "label": "EMA 50", "type": "price", "ops": OPS_PRICE},
    {"key": "EMA200", "label": "EMA 200", "type": "price", "ops": OPS_PRICE},
    {"key": "VWAP", "label": "VWAP", "type": "price", "ops": OPS_PRICE},
    {"key": "ATR", "label": "ATR", "type": "number", "ops": OPS_NUMBER},
    {"key": "Perf.W", "label": "Perf Week", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Perf.1M", "label": "Perf Month", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Perf.3M", "label": "Perf 3M", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Perf.6M", "label": "Perf 6M", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Perf.Y", "label": "Perf Year", "type": "percent", "ops": OPS_PERCENT},
    {"key": "Perf.YTD", "label": "Perf YTD", "type": "percent", "ops": OPS_PERCENT},
]

FIELD_BY_KEY = {f["key"]: f for f in SCREENER_FIELDS}


def list_screener_fields() -> list[dict[str, Any]]:
    return list(SCREENER_FIELDS)


def field_label(key: str) -> str:
    row = FIELD_BY_KEY.get(key)
    return str(row["label"]) if row else key
