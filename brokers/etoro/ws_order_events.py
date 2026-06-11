"""Map eToro private websocket / order-status payloads to trading event actions.

Status identifiers are taken from the eToro OpenAPI ``OrderForOpenInfoResponse``
schema (statusID field): 0=Pending, 1=Executed, 2=Cancelled, 3=Rejected,
4=Partially Executed.

Private websocket messages use ``type`` values such as
``Trading.OrderForCloseMultiple.Update`` (see websocket topics docs).
"""

from __future__ import annotations

from typing import Any

# Documented in OpenAPI OrderForOpenInfoResponse.statusID
STATUS_PENDING = 0
STATUS_EXECUTED = 1
STATUS_CANCELLED = 2
STATUS_REJECTED = 3
STATUS_PARTIALLY_EXECUTED = 4

TERMINAL_ACTIONS = {
    "ORDER_FILLED",
    "ORDER_REJECTED",
    "ORDER_CANCELLED",
    "POSITION_CLOSED",
}


def _first_value(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def _nested_status(content: dict[str, Any]) -> dict[str, Any]:
    status = content.get("status")
    return status if isinstance(status, dict) else {}


def parse_status_id(content: dict[str, Any]) -> int | None:
    raw = _first_value(content, "StatusID", "StatusId", "statusID", "statusId")
    if raw is None:
        raw = _nested_status(content).get("id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def parse_status_name(content: dict[str, Any]) -> str | None:
    raw = _first_value(content, "StatusName", "statusName")
    if raw is None:
        raw = _nested_status(content).get("name")
    if raw is None:
        return None
    return str(raw).strip()


def parse_error_code(content: dict[str, Any]) -> int | None:
    raw = _first_value(content, "ErrorCode", "errorCode")
    if raw is None:
        raw = _nested_status(content).get("errorCode")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def executed_units(content: dict[str, Any]) -> float:
    raw = _first_value(content, "ExecutedUnits", "executedUnits", "ExecutedLots", "executedLots")
    try:
        direct = float(raw or 0)
    except (TypeError, ValueError):
        direct = 0.0
    if direct > 0:
        return direct

    total = 0.0
    for execution in content.get("positionExecutions") or []:
        opening = execution.get("openingData") or {}
        for candidate in (
            opening.get("units"),
            execution.get("remainingUnits"),
            execution.get("executedUnits"),
        ):
            try:
                units = float(candidate or 0)
            except (TypeError, ValueError):
                units = 0.0
            if units > 0:
                total += units
                break
    return total


def is_close_event(event_type: str | None) -> bool:
    if not event_type:
        return False
    normalized = event_type.lower()
    return "orderforclose" in normalized


def is_open_event(event_type: str | None) -> bool:
    if not event_type:
        return False
    normalized = event_type.lower()
    return "orderforopen" in normalized


def extract_position_id(content: dict[str, Any]) -> str | None:
    direct = _first_value(content, "PositionID", "positionID", "positionId")
    if direct is not None:
        return str(direct)

    pending = content.get("PendingClosePositionIDs") or content.get("pendingClosePositionIDs") or []
    if pending:
        return str(pending[0])
    return None


def map_status_update_to_action(
    *,
    status_id: int | None,
    error_code: int | None,
    event_type: str | None = None,
    content: dict[str, Any] | None = None,
) -> str | None:
    """Return a terminal trading action or None when the update is not terminal."""
    content = content or {}

    status_name = (parse_status_name(content) or "").lower()

    if error_code not in (None, 0):
        return "ORDER_REJECTED"

    if status_name in {"cancelled", "canceled"}:
        return "ORDER_CANCELLED"
    if status_name == "rejected":
        return "ORDER_REJECTED"

    if status_id == STATUS_CANCELLED:
        return "ORDER_CANCELLED"
    if status_id == STATUS_REJECTED and status_name in {"", "rejected"}:
        return "ORDER_REJECTED"

    executed = executed_units(content)
    filled_names = {"filled", "executed", "partially executed", "partially filled"}
    is_executed = status_id in (STATUS_EXECUTED, STATUS_PARTIALLY_EXECUTED) or status_name in filled_names
    has_execution = executed > 0

    if is_executed or (has_execution and status_id not in (STATUS_PENDING, STATUS_CANCELLED, STATUS_REJECTED)):
        if is_close_event(event_type):
            return "POSITION_CLOSED"
        if is_open_event(event_type) or event_type is None:
            return "ORDER_FILLED"
        # Close-style payloads may omit the documented open prefix but include pending close IDs.
        if extract_position_id(content) and ("Close" in (event_type or "") or content.get("UnitsToDeduct") is not None):
            return "POSITION_CLOSED"
        return "ORDER_FILLED"

    return None


def map_websocket_update(event_type: str | None, content: dict[str, Any]) -> str | None:
    return map_status_update_to_action(
        status_id=parse_status_id(content),
        error_code=parse_error_code(content),
        event_type=event_type,
        content=content,
    )


def map_tracked_order_status(order_status: dict[str, Any]) -> str | None:
    status_id = parse_status_id(order_status)
    error_code = parse_error_code(order_status)
    return map_status_update_to_action(
        status_id=status_id,
        error_code=error_code,
        event_type="Trading.OrderForOpen.Update",
        content=order_status,
    )
