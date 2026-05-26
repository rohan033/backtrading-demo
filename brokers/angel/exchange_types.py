from __future__ import annotations

from SmartApi.smartWebSocketV2 import SmartWebSocketV2

EXCHANGE_TYPE_BY_CODE = {
    "NSE": SmartWebSocketV2.NSE_CM,
    "NFO": SmartWebSocketV2.NSE_FO,
    "BSE": SmartWebSocketV2.BSE_CM,
    "BFO": SmartWebSocketV2.BSE_FO,
    "MCX": SmartWebSocketV2.MCX_FO,
    "NCX": SmartWebSocketV2.NCX_FO,
    "CDE": SmartWebSocketV2.CDE_FO,
}


def exchange_type_for_code(exchange: str | None) -> int:
    normalized = (exchange or "NSE").strip().upper()
    return EXCHANGE_TYPE_BY_CODE.get(normalized, SmartWebSocketV2.NSE_CM)


def paise_to_rupees(price_in_paise: int | float | None) -> float | None:
    if price_in_paise is None:
        return None
    return float(price_in_paise) / 100.0
