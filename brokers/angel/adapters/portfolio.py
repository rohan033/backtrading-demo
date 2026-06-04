"""Map Angel SmartAPI holdings to control-plane portfolio rows."""

from __future__ import annotations

from typing import Any


def angel_portfolio_rows_from_holdings(raw_holdings: list[dict[str, Any]] | None) -> list[dict]:
    """Attach broker=angel to each holding dict from SmartAPI."""
    return [{**item, "broker": "angel"} for item in (raw_holdings or [])]
