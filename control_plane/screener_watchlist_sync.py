"""Sync screener result tickers into an eToro-backed watchlist."""

from __future__ import annotations

import logging
import re
from typing import Any

from control_plane.instrument_resolve import (
    pick_best_match,
    resolve_etoro_instrument_by_id,
    search_instruments,
)
from control_plane.screener_store import get_screener_store
from control_plane.watchlist_store import get_watchlist_store

log = logging.getLogger(__name__)

_EXCHANGE_PREFIX = re.compile(r"^[A-Z0-9]+:")


def ticker_to_symbol(ticker: str) -> str:
    """NASDAQ:AAPL -> AAPL"""
    raw = (ticker or "").strip().upper()
    if not raw:
        return ""
    return _EXCHANGE_PREFIX.sub("", raw)


def watchlist_name_for_screener(screener_name: str) -> str:
    base = (screener_name or "Screener").strip() or "Screener"
    return f"{base} Watchlist"


async def _resolve_etoro_row(
    symbol: str,
    *,
    account_env: str,
) -> dict[str, Any] | None:
    rows = await search_instruments("etoro", account_env, symbol)
    return pick_best_match(rows, symbol)


async def sync_screener_to_watchlist(
    screener_id: str,
    *,
    tickers: list[str] | None = None,
    account_env: str = "demo",
    instrument_overrides: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Add screener rows (selected or all) to `<name> Watchlist` on eToro.

    Returns a summary with per-ticker status.
    """
    store = get_screener_store()
    screener = store.get_screener(screener_id)
    if not screener:
        raise ValueError("Screener not found")

    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    overrides = {
        str(key).strip().upper(): int(value)
        for key, value in (instrument_overrides or {}).items()
        if str(key).strip() and value is not None
    }
    results = screener.get("results") or []
    if tickers is not None:
        wanted = {t.strip().upper() for t in tickers if t and t.strip()}
        results = [
            r
            for r in results
            if str(r.get("ticker") or "").upper() in wanted
            or str(r.get("name") or "").upper() in wanted
            or ticker_to_symbol(str(r.get("ticker") or "")).upper() in wanted
        ]

    wl_store = get_watchlist_store()
    wl_name = watchlist_name_for_screener(screener["name"])
    watchlist_id = screener.get("watchlist_id")
    watchlist = wl_store.get_watchlist(watchlist_id) if watchlist_id else None
    if not watchlist:
        # Prefer an existing watchlist with the same name + broker/env
        for wl in wl_store.list_watchlists():
            if (
                (wl.get("name") or "").strip().lower() == wl_name.lower()
                and (wl.get("broker") or "").lower() == "etoro"
                and (wl.get("account_env") or "").lower() == env
            ):
                watchlist = wl
                break
    if not watchlist:
        watchlist = wl_store.create_watchlist(wl_name, broker="etoro", account_env=env)
    store.update_screener(screener_id, watchlist_id=watchlist["id"])

    existing_tokens = {str(s.get("symboltoken")) for s in (watchlist.get("symbols") or [])}
    existing_symbols = {
        str(s.get("tradingsymbol") or s.get("symbol") or "").upper()
        for s in (watchlist.get("symbols") or [])
    }

    summary = {
        "watchlist_id": watchlist["id"],
        "watchlist_name": watchlist["name"],
        "account_env": env,
        "added": 0,
        "already_present": 0,
        "unmatched": 0,
        "failed": 0,
        "items": [],
    }

    seen_symbols: set[str] = set()
    for row in results:
        ticker = str(row.get("ticker") or row.get("name") or "").strip()
        symbol = ticker_to_symbol(ticker)
        if not symbol or symbol in seen_symbols:
            continue
        seen_symbols.add(symbol)

        if symbol in existing_symbols:
            summary["already_present"] += 1
            summary["items"].append(
                {"ticker": ticker, "symbol": symbol, "status": "already_present"}
            )
            continue

        override_id = (
            overrides.get(ticker.upper())
            or overrides.get(symbol.upper())
        )
        match: dict[str, Any] | None = None

        if override_id is not None:
            try:
                match = await resolve_etoro_instrument_by_id(
                    override_id,
                    account_env=env,
                    fallback_symbol=symbol,
                )
            except Exception as exc:
                log.debug(
                    "screener etoro instrument fetch failed %s id=%s: %s",
                    symbol,
                    override_id,
                    exc,
                )
                summary["failed"] += 1
                summary["items"].append(
                    {
                        "ticker": ticker,
                        "symbol": symbol,
                        "status": "failed",
                        "error": str(exc),
                        "instrument_id": override_id,
                    }
                )
                continue
        else:
            try:
                match = await _resolve_etoro_row(symbol, account_env=env)
            except Exception as exc:
                log.debug("screener etoro resolve failed %s: %s", symbol, exc)
                summary["failed"] += 1
                summary["items"].append(
                    {"ticker": ticker, "symbol": symbol, "status": "failed", "error": str(exc)}
                )
                continue

        if not match:
            summary["unmatched"] += 1
            summary["items"].append(
                {"ticker": ticker, "symbol": symbol, "status": "unmatched"}
            )
            continue

        token = str(match.get("symboltoken") or match.get("token") or "").strip()
        if not token:
            summary["unmatched"] += 1
            summary["items"].append(
                {"ticker": ticker, "symbol": symbol, "status": "unmatched"}
            )
            continue

        if token in existing_tokens:
            summary["already_present"] += 1
            summary["items"].append(
                {
                    "ticker": ticker,
                    "symbol": symbol,
                    "status": "already_present",
                    "symboltoken": token,
                }
            )
            continue

        raw_metadata = match if isinstance(match, dict) else None
        from brokers.etoro.adapters.portfolio import (
            coalesce_etoro_display_name,
            coalesce_etoro_tradingsymbol,
        )

        resolved_symbol = coalesce_etoro_tradingsymbol(match, fallback=symbol)
        display_name = coalesce_etoro_display_name(match, resolved_symbol)
        wl_store.add_symbol(
            watchlist["id"],
            symboltoken=token,
            tradingsymbol=resolved_symbol,
            exchange=str(match.get("exchange") or "ETORO"),
            symbol=display_name,
            internal_asset_class_name=match.get("internal_asset_class_name")
            or match.get("internalAssetClassName"),
            instrument_display_name=(
                match.get("instrument_display_name")
                or match.get("instrumentDisplayName")
                or match.get("displayName")
                or display_name
            ),
            logo35x35=match.get("logo35x35"),
            logo50x50=match.get("logo50x50"),
            logo150x150=match.get("logo150x150"),
            raw_metadata=raw_metadata,
        )
        try:
            from control_plane.etoro_db import get_etoro_db

            get_etoro_db().upsert_from_search_row(
                match,
                account_env=env,
                source="screener" if override_id is not None else "api",
            )
        except Exception:
            pass
        existing_tokens.add(token)
        existing_symbols.add(symbol)
        summary["added"] += 1
        summary["items"].append(
            {
                "ticker": ticker,
                "symbol": symbol,
                "status": "added",
                "symboltoken": token,
            }
        )

    return summary
