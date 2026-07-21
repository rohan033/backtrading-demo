from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("backtrading")


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
        token = str(row.get("symboltoken") or "").strip()
        if token and token.upper() == target:
            return row
    for row in rows:
        ts = str(row.get("tradingsymbol") or "").upper()
        if ts.split("-")[0] == target or ts.split(".")[0] == target:
            return row
    # Prefer an explicit watchlist hit when present.
    for row in rows:
        if row.get("from_watchlist"):
            return row
    return rows[0]


def find_watchlist_instrument(
    broker: str,
    account_env: str,
    ticker: str,
) -> dict[str, Any] | None:
    """Return a search-row shaped hit from the user's watchlists, if any."""
    query = str(ticker or "").strip()
    if not query:
        return None
    try:
        from control_plane.watchlist_store import get_watchlist_store

        hit = get_watchlist_store().find_symbol_by_ticker(
            broker=broker,
            account_env=account_env,
            ticker=query,
        )
    except Exception as exc:
        log.warning("[INSTRUMENT] watchlist lookup failed for %r: %s", query, exc)
        return None
    if not hit:
        return None

    tradingsymbol = str(hit.get("tradingsymbol") or query).strip()
    token = str(hit.get("symboltoken") or "").strip()
    if not token:
        return None
    broker_name = (broker or "angel").lower()
    return {
        "tradingsymbol": tradingsymbol,
        "symboltoken": token,
        "exchange": str(hit.get("exchange") or ("ETORO" if broker_name == "etoro" else "NSE")),
        "name": hit.get("instrument_display_name") or hit.get("symbol") or tradingsymbol,
        "symbol": hit.get("symbol") or tradingsymbol,
        "instrumentDisplayName": hit.get("instrument_display_name") or hit.get("symbol"),
        "logo35x35": hit.get("logo35x35"),
        "logo50x50": hit.get("logo50x50"),
        "logo150x150": hit.get("logo150x150"),
        "from_watchlist": True,
        "watchlist_id": hit.get("watchlist_id"),
        "watchlist_name": hit.get("watchlist_name"),
    }


def merge_watchlist_into_search_rows(
    broker: str,
    account_env: str,
    query: str,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Prepend/promote a matching watchlist instrument so agents reuse known IDs."""
    hit = find_watchlist_instrument(broker, account_env, query)
    if not hit:
        return rows
    token = str(hit.get("symboltoken") or "")
    rest = [row for row in rows if str(row.get("symboltoken") or "") != token]
    existing = next(
        (row for row in rows if str(row.get("symboltoken") or "") == token),
        None,
    )
    if existing:
        merged = {**existing, **{k: v for k, v in hit.items() if v not in (None, "")}}
        merged["from_watchlist"] = True
        log.info(
            "[INSTRUMENT] promoted watchlist hit query=%r token=%s symbol=%s list=%s",
            query,
            token,
            hit.get("tradingsymbol"),
            hit.get("watchlist_name"),
        )
        return [merged, *rest]
    log.info(
        "[INSTRUMENT] prepended watchlist hit query=%r token=%s symbol=%s list=%s",
        query,
        token,
        hit.get("tradingsymbol"),
        hit.get("watchlist_name"),
    )
    return [hit, *rest]


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
        rows = mock_search_rows(q)
        return merge_watchlist_into_search_rows(broker_name, account_env, q, rows)

    if broker_name == "etoro":
        from brokers.etoro.adapters.portfolio import etoro_instrument_to_search_row
        try:
            client = await _etoro_trading_client(account_env)
            instruments = await client.asearch_instruments(q)
            rows = [etoro_instrument_to_search_row(item) for item in instruments]
        except Exception as exc:
            log.warning("[INSTRUMENT] etoro search failed for %r: %s", q, exc)
            rows = []
        return merge_watchlist_into_search_rows(broker_name, account_env, q, rows)

    from api.server import get_client

    client = get_client()
    result = client._client.searchScrip(exchange, q)
    rows = result.get("data", []) or [] if result and result.get("status") else []
    return merge_watchlist_into_search_rows(broker_name, account_env, q, rows)


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

    # Prefer a known watchlist instrument ID before broker text search.
    watchlist_hit = find_watchlist_instrument(broker_name, account_env, sym)
    if watchlist_hit and str(watchlist_hit.get("symboltoken") or "").strip():
        tradingsymbol = str(watchlist_hit.get("tradingsymbol") or sym).strip()
        return ResolvedInstrument(
            symbol=tradingsymbol.split("-")[0] if broker_name == "angel" else tradingsymbol,
            token=str(watchlist_hit.get("symboltoken") or "").strip(),
            exchange=str(watchlist_hit.get("exchange") or default_exchange).strip(),
            tradingsymbol=tradingsymbol,
        )

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
