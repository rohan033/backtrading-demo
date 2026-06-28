"""Map eToro API records to control-plane portfolio/search rows."""

from __future__ import annotations


def mock_search_rows(q: str) -> list[dict]:
    mock_stocks = [
        {"tradingsymbol": "RELIANCE-EQ", "symboltoken": "2885", "exchange": "NSE"},
        {"tradingsymbol": "INFY-EQ", "symboltoken": "1594", "exchange": "NSE"},
        {"tradingsymbol": "TCS-EQ", "symboltoken": "11536", "exchange": "NSE"},
        {"tradingsymbol": "HDFCBANK-EQ", "symboltoken": "1333", "exchange": "NSE"},
        {"tradingsymbol": "BAJFINANCE-EQ", "symboltoken": "317", "exchange": "NSE"},
        {"tradingsymbol": "SBIN-EQ", "symboltoken": "3045", "exchange": "NSE"},
        {"tradingsymbol": "ICICIBANK-EQ", "symboltoken": "4963", "exchange": "NSE"},
        {"tradingsymbol": "LUPIN-EQ", "symboltoken": "10440", "exchange": "NSE"},
        {"tradingsymbol": "WIPRO-EQ", "symboltoken": "3787", "exchange": "NSE"},
        {"tradingsymbol": "TATAMOTORS-EQ", "symboltoken": "3456", "exchange": "NSE"},
    ]
    mock_crypto = [
        {"tradingsymbol": "BTC", "symboltoken": "100000", "exchange": "ETORO"},
        {"tradingsymbol": "ETH", "symboltoken": "100001", "exchange": "ETORO"},
        {"tradingsymbol": "AAPL", "symboltoken": "100002", "exchange": "ETORO"},
        {"tradingsymbol": "TSLA", "symboltoken": "100003", "exchange": "ETORO"},
    ]
    needle = q.upper()
    return [
        stock
        for stock in (mock_stocks + mock_crypto)
        if needle in stock["tradingsymbol"].upper()
    ]


def etoro_instrument_to_search_row(instrument: dict) -> dict:
    instrument_id = (
        instrument.get("instrumentId")
        or instrument.get("instrumentID")
        or instrument.get("InstrumentID")
    )
    symbol = (
        instrument.get("symbolFull")
        or instrument.get("internalSymbolFull")
        or instrument.get("symbol")
        or instrument.get("displayName")
        or str(instrument_id or "")
    )
    exchange = (
        instrument.get("exchangeName")
        or instrument.get("exchange")
        or instrument.get("exchangeCode")
        or "ETORO"
    )
    return {
        "tradingsymbol": symbol,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": exchange,
        "name": instrument.get("displayName") or instrument.get("instrumentDisplayName") or symbol,
        "internalAssetClassName": instrument.get("internalAssetClassName"),
        "instrumentDisplayName": (
            instrument.get("internalInstrumentDisplayName")
            or instrument.get("instrumentDisplayName")
            or instrument.get("displayName")
        ),
        "logo35x35": instrument.get("logo35x35"),
        "logo50x50": instrument.get("logo50x50"),
        "logo150x150": instrument.get("logo150x150"),
        "raw": instrument,
    }


def etoro_instrument_id(record: dict) -> int | None:
    raw = (
        record.get("instrumentID")
        or record.get("instrumentId")
        or record.get("InstrumentID")
    )
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def etoro_display_symbol(record: dict, symbol_map: dict[int, str] | None = None) -> str:
    instrument_id = etoro_instrument_id(record)
    for key in (
        "instrumentDisplayName",
        "InstrumentDisplayName",
        "symbolFull",
        "internalSymbolFull",
        "displayName",
        "DisplayName",
        "symbol",
        "Symbol",
    ):
        value = record.get(key)
        if value is not None and str(value).strip():
            text = str(value).strip()
            if instrument_id is None or text != str(instrument_id):
                return text
    if instrument_id is not None and symbol_map:
        mapped = symbol_map.get(instrument_id)
        if mapped:
            return mapped
    return str(instrument_id or "")


async def etoro_symbol_map_for_records(client, records: list[dict]) -> dict[int, str]:
    instrument_ids: list[int] = []
    seen: set[int] = set()
    for record in records:
        instrument_id = etoro_instrument_id(record)
        if instrument_id is not None and instrument_id not in seen:
            seen.add(instrument_id)
            instrument_ids.append(instrument_id)
    if not instrument_ids:
        return {}
    return await client.aget_instrument_symbol_map(instrument_ids)


def etoro_position_to_portfolio_row(position: dict, symbol_map: dict[int, str] | None = None) -> dict:
    instrument_id = etoro_instrument_id(position)
    symbol = etoro_display_symbol(position, symbol_map)
    units = position.get("units") or position.get("Units") or position.get("amount") or 0
    open_rate = position.get("openRate") or position.get("OpenRate") or position.get("open") or 0
    ltp = (
        position.get("currentRate")
        or position.get("CurrentRate")
        or position.get("rate")
        or position.get("openRate")
        or open_rate
    )
    return {
        "tradingsymbol": symbol,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": "ETORO",
        "quantity": str(units),
        "averageprice": str(open_rate),
        "ltp": str(ltp),
        "broker": "etoro",
    }


def enrich_etoro_orders_snapshot(snapshot: dict, symbol_map: dict[int, str]) -> dict:
    enriched: dict[str, list[dict]] = {}
    for key in ("orders", "orders_for_open", "orders_for_close"):
        items = []
        for item in snapshot.get(key) or []:
            if not isinstance(item, dict):
                continue
            row = dict(item)
            row["symbol"] = etoro_display_symbol(row, symbol_map)
            items.append(row)
        enriched[key] = items
    return enriched
