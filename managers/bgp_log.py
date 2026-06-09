"""Background poller (BGP) structured logging."""

from __future__ import annotations

import json
from typing import Any

from logzero import logger

BGP = "[BGP]"


def _payload(fields: dict[str, Any]) -> str:
    if not fields:
        return ""
    return json.dumps(fields, default=str, sort_keys=True)


def bgp_info(poller: str, event: str, **fields: Any) -> None:
    logger.info("%s poller=%s event=%s %s", BGP, poller, event, _payload(fields))


def bgp_warning(poller: str, event: str, **fields: Any) -> None:
    logger.warning("%s poller=%s event=%s %s", BGP, poller, event, _payload(fields))


def bgp_error(poller: str, event: str, **fields: Any) -> None:
    logger.error("%s poller=%s event=%s %s", BGP, poller, event, _payload(fields))


def summarize_etoro_position(position: dict[str, Any]) -> dict[str, Any]:
    position_id = position.get("positionID") or position.get("positionId")
    return {
        "position_id": str(position_id) if position_id is not None else None,
        "order_id": position.get("orderID") or position.get("orderId"),
        "units": position.get("units") or position.get("Units") or position.get("amount"),
        "open_rate": position.get("openRate") or position.get("OpenRate"),
        "instrument_id": position.get("instrumentID") or position.get("instrumentId"),
    }


def summarize_v2_order_lookup(order_id: str, lookup: dict[str, Any]) -> dict[str, Any]:
    status = lookup.get("status") or {}
    executions = []
    for execution in lookup.get("positionExecutions") or []:
        executions.append({
            "position_id": execution.get("positionId") or execution.get("positionID"),
            "state": execution.get("state"),
            "remaining_units": execution.get("remainingUnits"),
        })
    return {
        "order_id": str(order_id),
        "status_name": status.get("name"),
        "status_id": status.get("id"),
        "error_code": status.get("errorCode"),
        "last_update": lookup.get("lastUpdate") or lookup.get("last_update"),
        "position_executions": executions,
    }


def diff_summaries(
    previous: dict[str, dict[str, Any]],
    current: dict[str, dict[str, Any]],
    *,
    entity: str,
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for key, cur in current.items():
        prev = previous.get(key)
        if prev is None:
            changes.append({
                "change": f"{entity}_ADDED",
                "key": key,
                "current": cur,
                "previous": None,
            })
        elif prev != cur:
            changes.append({
                "change": f"{entity}_UPDATED",
                "key": key,
                "current": cur,
                "previous": prev,
            })
    for key, prev in previous.items():
        if key not in current:
            changes.append({
                "change": f"{entity}_REMOVED",
                "key": key,
                "current": None,
                "previous": prev,
            })
    return changes
