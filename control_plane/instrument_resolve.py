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
        log.debug("[INSTRUMENT] watchlist lookup failed for %r: %s", query, exc)
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
        return [merged, *rest]
    return [hit, *rest]


async def _etoro_trading_client(account_env: str):
    from brokers.etoro.trading_client import EtoroTradingClient

    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    client = EtoroTradingClient(account_env=env)
    client.generate_session()
    return client


async def resolve_etoro_instrument_by_id(
    instrument_id: int,
    *,
    account_env: str,
    fallback_symbol: str | None = None,
) -> dict[str, Any] | None:
    """Resolve a numeric eToro instrument ID to a watchlist/search row.

    Checks etoro_db first; only calls the eToro API on cache miss.
    """
    if instrument_id <= 0:
        return None

    from control_plane.etoro_db import get_etoro_db

    db = get_etoro_db()
    cached = db.find_by_instrument_id(account_env, instrument_id)
    if cached:
        row = db.to_search_row(cached)
        if fallback_symbol:
            from brokers.etoro.adapters.portfolio import (
                coalesce_etoro_display_name,
                coalesce_etoro_tradingsymbol,
            )

            ts = coalesce_etoro_tradingsymbol({**row, **cached}, fallback=fallback_symbol)
            row["tradingsymbol"] = ts
            row["symbol"] = coalesce_etoro_display_name({**row, **cached}, ts)
            row["name"] = row["symbol"]
        return row

    from brokers.etoro.adapters.portfolio import (
        coalesce_etoro_display_name,
        coalesce_etoro_tradingsymbol,
        etoro_display_map_for_records,
        etoro_instrument_to_search_row,
    )

    client = await _etoro_trading_client(account_env)
    records = await client.aget_instrument_records([instrument_id])
    record = records.get(instrument_id)
    if record:
        row = etoro_instrument_to_search_row(record)
        token = str(row.get("symboltoken") or instrument_id).strip()
        if token:
            row["symboltoken"] = token
            db.upsert_from_search_row(row, account_env=account_env, source="api")
            return row

    symbol_map = await client.aget_instrument_symbol_map([instrument_id])
    display_map = await etoro_display_map_for_records(
        client,
        [{"instrumentID": instrument_id}],
    )
    display = dict(display_map.get(instrument_id, {}))
    mapped_symbol = symbol_map.get(instrument_id)
    ticker = (
        mapped_symbol
        or display.get("tradingsymbol")
        or display.get("instrument_display_name")
    )
    if not ticker or str(ticker).isdigit():
        ticker = str(fallback_symbol or instrument_id)

    row = {
        "tradingsymbol": coalesce_etoro_tradingsymbol(
            {
                "tradingsymbol": str(ticker),
                "symboltoken": str(instrument_id),
                "instrument_display_name": display.get("instrument_display_name"),
                "instrumentDisplayName": display.get("instrument_display_name"),
            },
            fallback=str(fallback_symbol or ""),
        ),
        "symboltoken": str(instrument_id),
        "exchange": "ETORO",
        "name": display.get("instrument_display_name") or str(ticker),
        "symbol": coalesce_etoro_display_name(
            {"instrument_display_name": display.get("instrument_display_name")},
            coalesce_etoro_tradingsymbol(
                {"tradingsymbol": str(ticker), "symboltoken": str(instrument_id)},
                fallback=str(fallback_symbol or ""),
            ),
        ),
        "instrumentDisplayName": display.get("instrument_display_name"),
        "instrument_display_name": display.get("instrument_display_name"),
        "internalAssetClassName": display.get("internal_asset_class_name"),
        "internal_asset_class_name": display.get("internal_asset_class_name"),
        "logo35x35": display.get("logo35x35"),
        "logo50x50": display.get("logo50x50"),
        "logo150x150": display.get("logo150x150"),
    }
    db.upsert_from_search_row(row, account_env=account_env, source="api")
    return row


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
        from control_plane.etoro_algolia_search import search_etoro_algolia
        from control_plane.etoro_db import get_etoro_db
        from control_plane.etoro_search_cache import (
            current_cache_epoch,
            get_cached_search,
            put_cached_search,
        )
        from control_plane.etoro_search_settings import get_etoro_search_settings_store

        mode = get_etoro_search_settings_store().get_search_mode()
        cache_key = f"{mode}:{account_env}:{q.upper()}"
        epoch = current_cache_epoch()
        cached_rows = get_cached_search(cache_key, epoch)
        if cached_rows is not None:
            return merge_watchlist_into_search_rows(broker_name, account_env, q, cached_rows)

        db = get_etoro_db()
        db_hit = db.find_by_ticker(account_env, q)
        if db_hit:
            rows = [db.to_search_row(db_hit)]
            put_cached_search(cache_key, epoch, rows)
            return merge_watchlist_into_search_rows(broker_name, account_env, q, rows)

        if mode == "algolia":
            rows = await search_etoro_algolia(q)
        else:
            from brokers.etoro.adapters.portfolio import etoro_instrument_to_search_row

            try:
                client = await _etoro_trading_client(account_env)
                instruments = await client.asearch_instruments(q)
                rows = [etoro_instrument_to_search_row(item) for item in instruments]
            except Exception as exc:
                log.debug("[INSTRUMENT] etoro search failed for %r: %s", q, exc)
                rows = []

        for row in rows:
            db.upsert_from_search_row(row, account_env=account_env, source="api" if mode == "legacy" else "algolia")
        put_cached_search(cache_key, epoch, rows)
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

    if broker_name == "etoro":
        from control_plane.etoro_db import get_etoro_db

        db_hit = get_etoro_db().find_by_ticker(account_env, sym)
        if db_hit and str(db_hit.get("symboltoken") or "").strip():
            tradingsymbol = str(db_hit.get("tradingsymbol") or sym).strip()
            return ResolvedInstrument(
                symbol=tradingsymbol,
                token=str(db_hit.get("symboltoken") or "").strip(),
                exchange=str(db_hit.get("exchange") or default_exchange).strip(),
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

    if broker_name == "etoro":
        from control_plane.etoro_db import get_etoro_db

        get_etoro_db().upsert_from_search_row(hit, account_env=account_env, source="api")

    tradingsymbol = str(hit.get("tradingsymbol") or sym).strip()
    return ResolvedInstrument(
        symbol=tradingsymbol.split("-")[0] if broker_name == "angel" else tradingsymbol,
        token=str(hit.get("symboltoken") or "").strip(),
        exchange=str(hit.get("exchange") or default_exchange).strip(),
        tradingsymbol=tradingsymbol,
    )
