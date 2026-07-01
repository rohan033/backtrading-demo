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


def _is_numeric_symbol(text: str) -> bool:
    return bool(text) and text.isdigit()


def _logos_from_images(images: list | None) -> dict[str, str]:
    if not isinstance(images, list):
        return {}
    logos: dict[str, str] = {}
    fallback_png: tuple[int, str] | None = None
    for image in images:
        if not isinstance(image, dict):
            continue
        uri = image.get("uri") or image.get("url")
        if not uri:
            continue
        width = image.get("width")
        try:
            width_num = int(width) if width is not None else None
        except (TypeError, ValueError):
            width_num = None
        if width_num == 35:
            logos["logo35x35"] = str(uri)
        elif width_num == 50:
            logos["logo50x50"] = str(uri)
        elif width_num == 150:
            logos["logo150x150"] = str(uri)
        fmt = str(image.get("format") or "").lower()
        if fmt == "png" and width_num is not None:
            if fallback_png is None or width_num > fallback_png[0]:
                fallback_png = (width_num, str(uri))
    if fallback_png and not logos.get("logo150x150"):
        logos.setdefault("logo150x150", fallback_png[1])
    return logos


def metadata_from_etoro_record(record: dict | None) -> dict:
    if not isinstance(record, dict):
        return {}
    ticker = (
        record.get("symbolFull")
        or record.get("internalSymbolFull")
        or record.get("symbol")
    )
    display_name = (
        record.get("internalInstrumentDisplayName")
        or record.get("instrumentDisplayName")
        or record.get("instrument_display_name")
        or record.get("displayName")
        or ticker
    )
    logos = _logos_from_images(record.get("images"))
    return {
        "tradingsymbol": ticker,
        "internal_asset_class_name": record.get("internalAssetClassName") or record.get("internal_asset_class_name"),
        "instrument_display_name": display_name,
        "logo35x35": record.get("logo35x35") or logos.get("logo35x35"),
        "logo50x50": record.get("logo50x50") or logos.get("logo50x50"),
        "logo150x150": record.get("logo150x150") or logos.get("logo150x150"),
    }


def _merge_display_metadata(existing: dict, incoming: dict) -> dict:
    merged = dict(existing)
    for key, value in incoming.items():
        if value and not merged.get(key):
            merged[key] = value
    return merged


async def etoro_display_map_for_records(client, records: list[dict]) -> dict[int, dict]:
    instrument_ids: list[int] = []
    seen: set[int] = set()
    for record in records:
        instrument_id = etoro_instrument_id(record)
        if instrument_id is not None and instrument_id not in seen:
            seen.add(instrument_id)
            instrument_ids.append(instrument_id)
    if not instrument_ids:
        return {}

    display_map: dict[int, dict] = {}
    try:
        display_records = await client.aget_instrument_display_data(instrument_ids)
    except Exception:
        display_records = []
    for record in display_records:
        instrument_id = etoro_instrument_id(record)
        if instrument_id is None:
            continue
        display_map[instrument_id] = metadata_from_etoro_record(record)

    instrument_records = await client.aget_instrument_records(instrument_ids)
    for instrument_id, record in instrument_records.items():
        display_map[instrument_id] = _merge_display_metadata(
            display_map.get(instrument_id, {}),
            metadata_from_etoro_record(record),
        )

    return display_map


def portfolio_row_needs_symbol_enrichment(row: dict) -> bool:
    ticker = str(row.get("tradingsymbol") or "").strip()
    if not _is_numeric_symbol(ticker):
        return False
    name = str(row.get("instrument_display_name") or row.get("symbol") or "").strip()
    has_logo = bool(row.get("logo35x35") or row.get("logo50x50") or row.get("logo150x150"))
    if name and not _is_numeric_symbol(name) and has_logo:
        return False
    return True


async def rehydrate_etoro_portfolio_rows(client, rows: list[dict]) -> list[dict]:
    instrument_ids: list[int] = []
    for row in rows:
        if not portfolio_row_needs_symbol_enrichment(row):
            continue
        token = str(row.get("symboltoken") or row.get("tradingsymbol") or "").strip()
        if _is_numeric_symbol(token):
            instrument_ids.append(int(token))
    if not instrument_ids:
        return rows

    unique_ids = list(dict.fromkeys(instrument_ids))
    symbol_map = await etoro_symbol_map_for_records(
        client,
        [{"instrumentID": instrument_id} for instrument_id in unique_ids],
    )
    display_map = await etoro_display_map_for_records(
        client,
        [{"instrumentID": instrument_id} for instrument_id in unique_ids],
    )

    enriched: list[dict] = []
    for row in rows:
        token = str(row.get("symboltoken") or row.get("tradingsymbol") or "").strip()
        if not _is_numeric_symbol(token):
            enriched.append(row)
            continue

        instrument_id = int(token)
        display = display_map.get(instrument_id, {})
        mapped_symbol = symbol_map.get(instrument_id)
        new_row = dict(row)

        ticker = mapped_symbol or display.get("tradingsymbol") or display.get("instrument_display_name")
        if ticker and not _is_numeric_symbol(str(ticker)):
            new_row["tradingsymbol"] = str(ticker)

        display_name = display.get("instrument_display_name")
        if display_name and not _is_numeric_symbol(str(display_name)):
            new_row["instrument_display_name"] = str(display_name)
            new_row["symbol"] = str(display_name)

        for key in (
            "internal_asset_class_name",
            "instrument_display_name",
            "logo35x35",
            "logo50x50",
            "logo150x150",
        ):
            value = display.get(key)
            if value and not new_row.get(key):
                new_row[key] = value

        enriched.append(new_row)
    return enriched


def etoro_position_to_portfolio_row(
    position: dict,
    symbol_map: dict[int, str] | None = None,
    display_map: dict[int, dict] | None = None,
) -> dict:
    instrument_id = etoro_instrument_id(position)
    display = (display_map or {}).get(instrument_id, {}) if instrument_id is not None else {}
    symbol = etoro_display_symbol(position, symbol_map)
    mapped_symbol = symbol_map.get(instrument_id) if symbol_map and instrument_id is not None else None
    display_ticker = display.get("tradingsymbol")
    if mapped_symbol and not _is_numeric_symbol(mapped_symbol):
        symbol = mapped_symbol
    elif display_ticker and not _is_numeric_symbol(str(display_ticker)):
        symbol = str(display_ticker)
    elif _is_numeric_symbol(symbol):
        display_name = display.get("instrument_display_name")
        if display_name and not _is_numeric_symbol(str(display_name)):
            symbol = str(display_name)

    display_name = display.get("instrument_display_name") or symbol
    units = position.get("units") or position.get("Units") or position.get("amount") or 0
    open_rate = position.get("openRate") or position.get("OpenRate") or position.get("open") or 0
    ltp = (
        position.get("currentRate")
        or position.get("CurrentRate")
        or position.get("rate")
        or position.get("openRate")
        or open_rate
    )
    row = {
        "tradingsymbol": symbol,
        "symbol": display_name,
        "symboltoken": str(instrument_id) if instrument_id is not None else "",
        "exchange": "ETORO",
        "quantity": str(units),
        "averageprice": str(open_rate),
        "ltp": str(ltp),
        "broker": "etoro",
    }
    for key in (
        "internal_asset_class_name",
        "instrument_display_name",
        "logo35x35",
        "logo50x50",
        "logo150x150",
    ):
        value = display.get(key)
        if value:
            row[key] = value
    return row


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
