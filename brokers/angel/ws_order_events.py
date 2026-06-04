from __future__ import annotations

from typing import Any

TERMINAL_ORDER_STATUS_CODES = frozenset({"AB02", "AB03", "AB05", "AB07"})


def _angel_textual_status(order_data: dict[str, Any]) -> str:
    return str(order_data.get("status") or order_data.get("orderstatus") or "").strip().lower()


def map_angel_order_status(payload: dict[str, Any]) -> str | None:
    order_status_code = str(payload.get("order-status") or payload.get("order_status") or "").upper()
    order_data = payload.get("orderData") if isinstance(payload.get("orderData"), dict) else {}
    textual_status = _angel_textual_status(order_data)

    if order_status_code == "AB00":
        return None
    if order_status_code in {"AB05"} or textual_status in {"complete", "completed", "filled"}:
        return "ORDER_FILLED"
    if order_status_code in {"AB02", "AB07"} or textual_status in {"cancelled", "canceled"}:
        return "ORDER_CANCELLED"
    if order_status_code in {"AB03"} or textual_status in {"rejected"}:
        return "ORDER_REJECTED"
    if order_status_code in {"AB04", "AB08"} or textual_status in {"modified"}:
        return "ORDER_MODIFIED"
    # Pending before open — do not lump "pending" and "open" (or "open pending") into ORDER_OPEN.
    if textual_status == "pending" or "pending" in textual_status.split():
        return "ORDER_PENDING"
    if order_status_code in {"AB09", "AB10", "AB11"}:
        return "ORDER_PENDING"
    if textual_status == "open" or order_status_code in {"AB01"}:
        return "ORDER_OPEN"
    return None
