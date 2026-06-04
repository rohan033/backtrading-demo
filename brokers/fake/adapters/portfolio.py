"""Demo portfolio rows for fake broker (control plane / UI smoke)."""

from __future__ import annotations


def fake_portfolio_rows() -> list[dict]:
    return [
        {
            "tradingsymbol": "FAKE-EQ",
            "symboltoken": "1",
            "exchange": "NSE",
            "quantity": "10",
            "averageprice": "100",
            "ltp": "105",
            "broker": "fake",
        }
    ]
