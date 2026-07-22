"""Candidate screening and ranking for 1% trading sessions."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from control_plane.instrument_resolve import (
    find_watchlist_instrument,
    pick_best_match,
    search_instruments,
)
from control_plane.screener_query import (
    ONE_PERCENT_QUERY_PRESETS,
    ScreenerDefinition,
    run_scanner,
)
from control_plane.screener_watchlist_sync import ticker_to_symbol

log = logging.getLogger("backtrading")

US_EASTERN = ZoneInfo("America/New_York")


def detect_market_phase(now: datetime | None = None) -> str:
    """Return premarket | regular | afterhours for US equities."""
    current = (now or datetime.now(timezone.utc)).astimezone(US_EASTERN)
    minutes = current.hour * 60 + current.minute
    # Premarket roughly 04:00–09:30 ET
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return "premarket"
    # Regular session 09:30–16:00 ET
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return "regular"
    return "afterhours"


def choose_query_key(phase: str | None = None) -> str:
    market_phase = phase or detect_market_phase()
    if market_phase == "premarket":
        return "premarket_gainers"
    if market_phase == "regular":
        return "top_trending"
    return "hot_stocks"


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_candidate(row: dict[str, Any], *, query_key: str, query_name: str) -> dict[str, Any]:
    raw_ticker = str(row.get("ticker") or row.get("name") or "").strip()
    symbol = ticker_to_symbol(raw_ticker) if raw_ticker else ""
    close = _num(row.get("close") or row.get("premarket_close"))
    change = _num(row.get("change") or row.get("premarket_change"))
    volume = _num(row.get("volume") or row.get("premarket_volume"))
    rel_volume = _num(row.get("relative_volume_10d_calc"))
    perf_w = _num(row.get("Perf.W"))
    score = 0.0
    if change is not None:
        score += change * 2.0
    if rel_volume is not None:
        score += rel_volume * 3.0
    if volume is not None:
        score += min(volume / 1_000_000.0, 10.0)
    if perf_w is not None:
        score += perf_w
    return {
        "ticker": raw_ticker,
        "symbol": symbol or raw_ticker.split(":")[-1],
        "name": row.get("name") or symbol or raw_ticker,
        "close": close,
        "change_pct": change,
        "volume": volume,
        "relative_volume": rel_volume,
        "perf_week": perf_w,
        "market_cap": _num(row.get("market_cap_basic")),
        "score": round(score, 4),
        "query_key": query_key,
        "query_name": query_name,
        "raw": row,
    }


def rank_candidates(
    rows: list[dict[str, Any]],
    *,
    query_key: str,
    query_name: str,
    exclude_symbols: set[str] | None = None,
    min_score: float = 0.0,
    limit: int = 20,
    watchlist_roots: set[str] | None = None,
) -> list[dict[str, Any]]:
    excluded = {s.strip().upper() for s in (exclude_symbols or set()) if s}
    known = {s.strip().upper() for s in (watchlist_roots or set()) if s}
    ranked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        candidate = normalize_candidate(row, query_key=query_key, query_name=query_name)
        symbol = str(candidate.get("symbol") or "").upper()
        if not symbol or symbol in seen or symbol in excluded:
            continue
        root = symbol.split(".", 1)[0].split("-", 1)[0]
        on_watchlist = root in known or symbol in known
        close = candidate.get("close")
        # Keep watchlist-known names even when under the usual $20 / $10B gates —
        # those IDs are already trusted and tradable on eToro.
        if not on_watchlist:
            if close is None or float(close) < 20:
                continue
            market_cap = candidate.get("market_cap")
            if market_cap is not None and float(market_cap) < 10_000_000_000:
                continue
        elif close is None or float(close) <= 0:
            continue
        if float(candidate.get("score") or 0) < float(min_score or 0):
            continue
        seen.add(symbol)
        candidate["on_watchlist"] = on_watchlist
        ranked.append(candidate)
    ranked.sort(
        key=lambda item: (
            1 if item.get("on_watchlist") else 0,
            float(item.get("score") or 0),
        ),
        reverse=True,
    )
    return ranked[:limit]


def _watchlist_roots_for_env(account_env: str) -> set[str]:
    try:
        from control_plane.watchlist_store import get_watchlist_store

        return get_watchlist_store().list_ticker_roots(
            broker="etoro",
            account_env=account_env,
        )
    except Exception as exc:
        log.warning("[1PC] watchlist root scan failed: %s", exc)
        return set()


def _etoro_rate_ltp(rate: dict[str, Any] | None) -> float | None:
    if not isinstance(rate, dict):
        return None
    for key in ("lastExecution", "LastExecution", "close", "Close"):
        raw = rate.get(key)
        if raw is None or raw == "":
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    bid = rate.get("bid") or rate.get("Bid")
    ask = rate.get("ask") or rate.get("Ask")
    try:
        if bid is not None and ask is not None:
            mid = (float(bid) + float(ask)) / 2.0
            return mid if mid > 0 else None
        if bid is not None and float(bid) > 0:
            return float(bid)
        if ask is not None and float(ask) > 0:
            return float(ask)
    except (TypeError, ValueError):
        return None
    return None


def _symbol_equity_preference(tradingsymbol: str, target: str) -> int:
    """Higher is better for US equity screener → eToro mapping."""
    ts = tradingsymbol.strip().upper()
    tgt = target.strip().upper()
    if ts in {f"{tgt}.US", f"{tgt}.RTH"}:
        return 3
    if ts == tgt:
        return 1  # bare ticker often crypto/CFD collision (STX → Stacks)
    if ts.startswith(f"{tgt}."):
        return 2
    return 0


async def resolve_etoro_candidate(
    candidate: dict[str, Any],
    *,
    account_env: str = "demo",
) -> dict[str, Any] | None:
    """Map a TradingView equity ticker to the matching eToro instrument.

    Prefer a known watchlist instrument ID when the ticker is already saved.
    Otherwise prefer the instrument whose live eToro LTP is closest to the
    screener close. Bare tickers like STX can resolve to crypto (Stacks @ $0.17)
    while the screener meant Seagate (~$794) listed as STX.US / STX.RTH.
    """
    symbol = str(candidate.get("symbol") or "").strip()
    if not symbol:
        return None
    screener_px = _num(candidate.get("close"))

    watchlist_hit = find_watchlist_instrument("etoro", account_env, symbol)
    if watchlist_hit:
        token = str(watchlist_hit.get("symboltoken") or "").strip()
        tradingsymbol = str(watchlist_hit.get("tradingsymbol") or symbol).strip()
        if token:
            ltp = None
            try:
                from brokers.etoro.trading_client import EtoroTradingClient

                client = EtoroTradingClient(
                    account_env="demo" if account_env == "demo" else "live",
                )
                client.generate_session()
                rates = await client.aget_rates([int(token)])
                if rates:
                    ltp = _etoro_rate_ltp(rates[0] if isinstance(rates[0], dict) else None)
            except Exception as exc:
                log.info("[1PC] watchlist LTP fetch skipped for %s: %s", tradingsymbol, exc)
            close_px = float(ltp) if ltp and ltp > 0 else screener_px
            log.info(
                "[1PC] using watchlist instrument %s token=%s list=%s",
                tradingsymbol,
                token,
                watchlist_hit.get("watchlist_name"),
            )
            return {
                **candidate,
                "symbol": tradingsymbol,
                "tradingsymbol": tradingsymbol,
                "symboltoken": token,
                "exchange": "ETORO",
                "close": close_px,
                "etoro_ltp": ltp,
                "screener_close": screener_px,
                "instrument_name": (
                    watchlist_hit.get("name")
                    or watchlist_hit.get("instrumentDisplayName")
                    or candidate.get("name")
                ),
                "logo35x35": watchlist_hit.get("logo35x35"),
                "logo50x50": watchlist_hit.get("logo50x50"),
                "logo150x150": watchlist_hit.get("logo150x150"),
                "etoro_available": True,
                "from_watchlist": True,
                "watchlist_name": watchlist_hit.get("watchlist_name"),
            }

    try:
        rows = await search_instruments("etoro", account_env, symbol, exchange="ETORO")
    except Exception as exc:
        log.warning("[1PC] eToro resolve failed for %s: %s", symbol, exc)
        return None
    if not rows:
        return None

    tokens: list[int] = []
    by_token: dict[int, dict[str, Any]] = {}
    for row in rows:
        raw_token = row.get("symboltoken")
        try:
            token_i = int(raw_token)
        except (TypeError, ValueError):
            continue
        tokens.append(token_i)
        by_token[token_i] = row
    if not tokens:
        return None

    from brokers.etoro.trading_client import EtoroTradingClient

    client = EtoroTradingClient(account_env="demo" if account_env == "demo" else "live")
    client.generate_session()
    try:
        rates = await client.aget_rates(tokens)
    except Exception as exc:
        log.warning("[1PC] eToro rates failed for %s: %s", symbol, exc)
        rates = []

    rate_by_id: dict[int, dict[str, Any]] = {}
    for rate in rates or []:
        if not isinstance(rate, dict):
            continue
        rid = rate.get("instrumentID") or rate.get("instrumentId")
        try:
            rate_by_id[int(rid)] = rate
        except (TypeError, ValueError):
            continue

    # Max relative gap between screener close and eToro LTP before we reject.
    max_divergence = 0.25
    ranked_hits: list[tuple[float, int, float, dict[str, Any]]] = []
    for token_i, row in by_token.items():
        ltp = _etoro_rate_ltp(rate_by_id.get(token_i))
        if ltp is None or ltp <= 0:
            continue
        ts = str(row.get("tradingsymbol") or symbol)
        pref = _symbol_equity_preference(ts, symbol)
        if screener_px and screener_px > 0:
            divergence = abs(ltp - screener_px) / screener_px
            if divergence > max_divergence:
                log.info(
                    "[1PC] skip eToro instrument %s token=%s ltp=%.4f vs screener=%.4f "
                    "(divergence=%.1f%%)",
                    ts,
                    token_i,
                    ltp,
                    screener_px,
                    divergence * 100.0,
                )
                continue
            # Lower divergence is better; prefer .US/.RTH on ties.
            sort_key = (divergence, -pref)
        else:
            sort_key = (0.0, -pref)
            divergence = 0.0
        ranked_hits.append((sort_key[0], -pref, ltp, row))

    if not ranked_hits:
        # Fall back to name match only when we have no screener price to validate.
        hit = pick_best_match(rows, symbol)
        if not hit or screener_px:
            log.warning(
                "[1PC] no eToro instrument near screener price for %s (close=%s)",
                symbol,
                screener_px,
            )
            return None
        ltp = None
    else:
        ranked_hits.sort(key=lambda item: (item[0], item[1]))
        _, _, ltp, hit = ranked_hits[0]

    tradingsymbol = str(hit.get("tradingsymbol") or symbol).strip()
    token = str(hit.get("symboltoken") or "").strip()
    if not token:
        return None
    # Use broker LTP for sizing/brackets when available (not TradingView close).
    close_px = float(ltp) if ltp and ltp > 0 else screener_px
    return {
        **candidate,
        "symbol": tradingsymbol,
        "tradingsymbol": tradingsymbol,
        "symboltoken": token,
        "exchange": "ETORO",
        "close": close_px,
        "etoro_ltp": ltp,
        "screener_close": screener_px,
        "instrument_name": hit.get("name") or hit.get("instrumentDisplayName") or candidate.get("name"),
        "logo35x35": hit.get("logo35x35"),
        "logo50x50": hit.get("logo50x50"),
        "logo150x150": hit.get("logo150x150"),
        "etoro_available": True,
        "from_watchlist": bool(hit.get("from_watchlist")),
    }


async def find_tradeable_candidates(
    *,
    account_env: str = "demo",
    exclude_symbols: set[str] | None = None,
    query_key: str | None = None,
    query_keys: list[str] | None = None,
    screener_ids: list[str] | None = None,
    screener_mode: str = "auto",
    min_score: float = 0.0,
    limit: int = 12,
) -> dict[str, Any]:
    """Run one or more screeners and return ranked eToro-resolvable candidates."""
    phase = detect_market_phase()
    mode = (screener_mode or "auto").strip().lower()
    keys = [str(k).strip() for k in (query_keys or []) if str(k).strip()]
    ids = [str(i).strip() for i in (screener_ids or []) if str(i).strip()]

    if mode != "manual" or (not keys and not ids):
        keys = [query_key or choose_query_key(phase)]
        ids = []
        mode = "auto"

    sources: list[dict[str, Any]] = []
    merged_rows: list[dict[str, Any]] = []
    total_found = 0
    columns: list[str] = []
    query_names: list[str] = []

    for key in keys:
        preset = ONE_PERCENT_QUERY_PRESETS.get(key)
        if not preset:
            log.warning("[1PC] unknown preset key=%s", key)
            continue
        definition: ScreenerDefinition = preset["definition"]
        name = str(preset["name"])
        try:
            total, rows, cols = run_scanner(definition)
        except Exception as exc:
            log.warning("[1PC] scanner failed preset=%s: %s", key, exc)
            continue
        total_found += int(total or len(rows) or 0)
        if cols and not columns:
            columns = list(cols)
        for row in rows or []:
            if isinstance(row, dict):
                tagged = dict(row)
                tagged["_source_key"] = key
                tagged["_source_name"] = name
                merged_rows.append(tagged)
        sources.append({"type": "preset", "key": key, "name": name, "rows": len(rows or [])})
        if name not in query_names:
            query_names.append(name)

    if ids:
        from control_plane.screener_store import get_screener_store

        store = get_screener_store()
        for screener_id in ids:
            saved = store.get_screener(screener_id, include_results=False)
            if not saved:
                log.warning("[1PC] saved screener missing id=%s", screener_id)
                continue
            try:
                definition = ScreenerDefinition.from_dict(saved.get("definition") or {})
            except Exception as exc:
                log.warning("[1PC] bad saved screener id=%s: %s", screener_id, exc)
                continue
            name = str(saved.get("name") or screener_id)
            try:
                total, rows, cols = run_scanner(definition)
            except Exception as exc:
                log.warning("[1PC] scanner failed screener_id=%s: %s", screener_id, exc)
                continue
            total_found += int(total or len(rows) or 0)
            if cols and not columns:
                columns = list(cols)
            for row in rows or []:
                if isinstance(row, dict):
                    tagged = dict(row)
                    tagged["_source_key"] = f"saved:{screener_id}"
                    tagged["_source_name"] = name
                    merged_rows.append(tagged)
            sources.append({
                "type": "saved",
                "id": screener_id,
                "name": name,
                "rows": len(rows or []),
            })
            if name not in query_names:
                query_names.append(name)

    if not sources:
        fallback_key = choose_query_key(phase)
        preset = ONE_PERCENT_QUERY_PRESETS.get(fallback_key) or next(
            iter(ONE_PERCENT_QUERY_PRESETS.values())
        )
        definition = preset["definition"]
        name = str(preset["name"])
        total, rows, columns = run_scanner(definition)
        total_found = int(total or len(rows) or 0)
        for row in rows or []:
            if isinstance(row, dict):
                tagged = dict(row)
                tagged["_source_key"] = fallback_key
                tagged["_source_name"] = name
                merged_rows.append(tagged)
        keys = [fallback_key]
        query_names = [name]
        sources = [{"type": "preset", "key": fallback_key, "name": name, "rows": len(rows or [])}]
        mode = "auto"

    primary_key = keys[0] if keys else (sources[0].get("key") or sources[0].get("id") or "mixed")
    primary_name = " + ".join(query_names) if query_names else "Mixed screeners"

    watchlist_roots = _watchlist_roots_for_env(account_env)
    if watchlist_roots:
        log.info(
            "[1PC] watchlist roots available env=%s count=%d",
            account_env,
            len(watchlist_roots),
        )

    ranked = rank_candidates(
        merged_rows,
        query_key=str(primary_key),
        query_name=primary_name,
        exclude_symbols=exclude_symbols,
        min_score=min_score,
        limit=max(limit * 3, 20),
        watchlist_roots=watchlist_roots,
    )

    resolved: list[dict[str, Any]] = []
    unresolved: list[str] = []
    for candidate in ranked:
        if len(resolved) >= limit:
            break
        hit = await resolve_etoro_candidate(candidate, account_env=account_env)
        if hit:
            resolved.append(hit)
        else:
            unresolved.append(str(candidate.get("symbol") or ""))

    # Last resort: among screener rows that never made the ranked cut, still try
    # tickers that already exist on the user's eToro watchlists.
    if not resolved and watchlist_roots:
        log.warning(
            "[1PC] no resolved candidates — falling back to watchlist intersection "
            "(ranked=%d unresolved=%s)",
            len(ranked),
            unresolved[:8],
        )
        seen = {str(c.get("symbol") or "").upper() for c in ranked}
        fallback_rows: list[dict[str, Any]] = []
        for row in merged_rows:
            candidate = normalize_candidate(
                row, query_key=str(primary_key), query_name=primary_name,
            )
            symbol = str(candidate.get("symbol") or "").upper()
            root = symbol.split(".", 1)[0].split("-", 1)[0]
            if not symbol or symbol in seen:
                continue
            if root not in watchlist_roots and symbol not in watchlist_roots:
                continue
            seen.add(symbol)
            candidate["on_watchlist"] = True
            fallback_rows.append(candidate)
        for candidate in fallback_rows:
            if len(resolved) >= limit:
                break
            hit = await resolve_etoro_candidate(candidate, account_env=account_env)
            if hit:
                resolved.append(hit)
            else:
                unresolved.append(str(candidate.get("symbol") or ""))

    return {
        "market_phase": phase,
        "screener_mode": mode,
        "query_key": primary_key,
        "query_keys": keys,
        "screener_ids": ids,
        "query_name": primary_name,
        "query_names": query_names,
        "min_score": float(min_score or 0),
        "sources": sources,
        "total_found": total_found,
        "columns": columns,
        "candidates": resolved,
        "unresolved": [s for s in unresolved if s],
        "watchlist_roots_count": len(watchlist_roots),
    }


def compute_attempt_brackets(
    *,
    entry_price: float,
    capital: float,
    take_profit_pct: float,
    stop_loss_pct: float,
    cumulative_pnl: float,
    target_dollars: float,
) -> dict[str, float]:
    """Compute fixed per-stock TP/SL prices from configured percentages.

    Session ``target_dollars`` remains a global finish condition after attempts settle;
    it must not inflate this attempt's take-profit percentage.
    """
    remaining = float(target_dollars) - float(cumulative_pnl or 0)
    recovery_amount = max(0.0, -float(cumulative_pnl or 0))
    effective_tp_pct = float(take_profit_pct)
    tp_price = round(float(entry_price) * (1 + effective_tp_pct / 100.0), 2)
    sl_price = round(float(entry_price) * (1 - float(stop_loss_pct) / 100.0), 2)
    return {
        "take_profit_pct": round(effective_tp_pct, 4),
        "take_profit_price": tp_price,
        "stop_loss_pct": float(stop_loss_pct),
        "stop_loss_price": sl_price,
        "recovery_amount": round(recovery_amount, 2),
        "remaining_target": round(remaining, 2),
    }
