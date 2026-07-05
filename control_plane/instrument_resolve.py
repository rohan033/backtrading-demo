from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class ResolvedInstrument:
    symbol: str
    token: str
    exchange: str
    tradingsymbol: str


def pick_best_match(rows: list[dict[str, Any]], ticker: str) -> dict[str, Any] | None:
    if not rows:
        return None
    target = ticker.strip().upper()
    if not target:
        return rows[0]
    for row in rows:
        ts = str(row.get("tradingsymbol") or "").upper()
        if ts == target:
            return row
    for row in rows:
        ts = str(row.get("tradingsymbol") or "").upper()
        if ts.split("-")[0] == target:
            return row
    return rows[0]


async def _etoro_trading_client(account_env: str):
    from brokers.etoro.trading_client import EtoroTradingClient

    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    client = EtoroTradingClient(account_env=env)
    client.generate_session()
    return client


async def search_instruments(
    broker: str,
    account_env: str,
    query: str,
    *,
    exchange: str = "NSE",
    use_fake: bool = False,
) -> list[dict[str, Any]]:
    broker_name = "fake" if use_fake else (broker or "angel").lower()
    q = query.strip()
    if not q:
        return []

    if broker_name == "fake":
        from brokers.etoro.adapters.portfolio import mock_search_rows
        return mock_search_rows(q)

    if broker_name == "etoro":
        from brokers.etoro.adapters.portfolio import etoro_instrument_to_search_row
        client = await _etoro_trading_client(account_env)
        instruments = await client.asearch_instruments(q)
        return [etoro_instrument_to_search_row(item) for item in instruments]

    from api.server import get_client

    client = get_client()
    result = client._client.searchScrip(exchange, q)
    if result and result.get("status"):
        return result.get("data", []) or []
    return []


async def resolve_instrument(
    broker: str,
    account_env: str,
    symbol: str | None = None,
    token: str | None = None,
    exchange: str | None = None,
) -> ResolvedInstrument | None:
    """Resolve symbol/token/exchange for a broker instrument."""
    use_fake = os.getenv("TRADING_SESSION_USE_FAKE_SEARCH", "").lower() in {"1", "true", "yes"}
    broker_name = (broker or "etoro").lower()

    if token and symbol:
        return ResolvedInstrument(
            symbol=str(symbol).strip(),
            token=str(token).strip(),
            exchange=str(exchange or ("ETORO" if broker_name == "etoro" else "NSE")).strip(),
            tradingsymbol=str(symbol).strip(),
        )

    if token and not symbol:
        return ResolvedInstrument(
            symbol=str(token).strip(),
            token=str(token).strip(),
            exchange=str(exchange or ("ETORO" if broker_name == "etoro" else "NSE")).strip(),
            tradingsymbol=str(token).strip(),
        )

    sym = str(symbol or "").strip()
    if not sym:
        return None

    default_exchange = exchange or ("ETORO" if broker_name == "etoro" else "NSE")
    rows = await search_instruments(
        broker_name,
        account_env,
        sym,
        exchange=default_exchange,
        use_fake=use_fake,
    )
    hit = pick_best_match(rows, sym)
    if not hit:
        return None

    tradingsymbol = str(hit.get("tradingsymbol") or sym).strip()
    return ResolvedInstrument(
        symbol=tradingsymbol.split("-")[0] if broker_name == "angel" else tradingsymbol,
        token=str(hit.get("symboltoken") or "").strip(),
        exchange=str(hit.get("exchange") or default_exchange).strip(),
        tradingsymbol=tradingsymbol,
    )
