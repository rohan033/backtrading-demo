from __future__ import annotations

from typing import Any

TERMINAL_ORDER_STATUS_CODES = frozenset({"AB02", "AB03", "AB05", "AB07"})


def map_angel_order_status(payload: dict[str, Any]) -> str | None:
    order_status_code = str(payload.get("order-status") or payload.get("order_status") or "").upper()
    order_data = payload.get("orderData") if isinstance(payload.get("orderData"), dict) else {}
    textual_status = str(order_data.get("status") or order_data.get("orderstatus") or "").lower()

    if order_status_code == "AB00":
        return None
    if order_status_code in {"AB05"} or textual_status in {"complete", "completed", "filled"}:
        return "ORDER_FILLED"
    if order_status_code in {"AB02", "AB07"} or textual_status in {"cancelled", "canceled"}:
        return "ORDER_CANCELLED"
    if order_status_code in {"AB03"} or textual_status in {"rejected"}:
        return "ORDER_REJECTED"
    if order_status_code in {"AB01", "AB09", "AB10", "AB11"} or textual_status in {"open", "pending"}:
        return "ORDER_OPEN"
    if order_status_code in {"AB04", "AB08"} or textual_status in {"modified"}:
        return "ORDER_MODIFIED"
    return None
