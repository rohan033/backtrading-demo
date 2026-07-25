"""eToro public Algolia instrument search (exact visible stock tickers)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("backtrading")

ETORO_ALGOLIA_ENDPOINT = "https://x9rg52m4oj-dsn.algolia.net/1/indexes/*/queries"
ETORO_ALGOLIA_APPLICATION_ID = "X9RG52M4OJ"
ETORO_ALGOLIA_SEARCH_KEY = "7a66b9f7dc582e2803b8d188025e95ba"
ETORO_ALGOLIA_INDEX = "prod_Instruments"


def _image_uri(images: dict[str, Any] | None, variant: str) -> str | None:
    if not isinstance(images, dict):
        return None
    entry = images.get(variant)
    if not isinstance(entry, dict):
        return None
    uri = entry.get("uri")
    if isinstance(uri, str) and uri.strip():
        return uri.strip()
    return None


def algolia_hit_to_search_row(hit: dict[str, Any]) -> dict[str, Any]:
    instrument_id = hit.get("instrumentId") or hit.get("instrumentID")
    symbol_full = str(hit.get("symbolFull") or "").strip()
    display_name = str(hit.get("instrumentDisplayName") or symbol_full).strip()
    images = hit.get("images") if isinstance(hit.get("images"), dict) else {}
    return {
        "tradingsymbol": symbol_full,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": str(hit.get("exchange") or "ETORO"),
        "name": display_name or symbol_full,
        "symbol": symbol_full,
        "instrumentDisplayName": display_name or symbol_full,
        "logo35x35": _image_uri(images, "35x35"),
        "logo50x50": _image_uri(images, "50x50"),
        "logo150x150": _image_uri(images, "150x150"),
        "raw": hit,
    }


def pick_algolia_stock_hit(hits: list[dict[str, Any]], query: str) -> dict[str, Any] | None:
    target = query.strip().upper()
    if not target:
        return None
    for hit in hits:
        if str(hit.get("symbolFull") or "").strip().upper() != target:
            continue
        if str(hit.get("instrumentType") or "").lower() != "stocks":
            continue
        if hit.get("isVisible") is not True:
            continue
        if hit.get("isViewOnly") is not False:
            continue
        instrument_id = hit.get("instrumentId") or hit.get("instrumentID")
        if instrument_id is None:
            continue
        return hit
    return None


async def search_etoro_algolia(query: str) -> list[dict[str, Any]]:
    q = query.strip()
    if not q:
        return []

    url = (
        f"{ETORO_ALGOLIA_ENDPOINT}"
        f"?x-algolia-application-id={ETORO_ALGOLIA_APPLICATION_ID}"
        f"&x-algolia-api-key={ETORO_ALGOLIA_SEARCH_KEY}"
    )
    payload = {
        "requests": [{
            "indexName": ETORO_ALGOLIA_INDEX,
            "query": q,
            "params": "hitsPerPage=15",
        }],
    }

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.post(
                url,
                headers={"content-type": "application/x-www-form-urlencoded"},
                json=payload,
            )
            response.raise_for_status()
            body = response.json()
    except Exception as exc:
        log.warning("[ETORO_ALGOLIA] search failed for %r: %s", q, exc)
        return []

    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list) or not results:
        return []
    first = results[0] if isinstance(results[0], dict) else {}
    hits = first.get("hits") if isinstance(first.get("hits"), list) else []
    hit = pick_algolia_stock_hit(hits, q)
    if not hit:
        return []
    return [algolia_hit_to_search_row(hit)]
