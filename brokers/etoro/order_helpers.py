from __future__ import annotations

from typing import Any

DEFAULT_BRACKET_STOP_LOSS_AMOUNT = 20.0

_ETORO_PRICE_KEYS = frozenset({
    "amount",
    "Amount",
    "stopLossRate",
    "takeProfitRate",
    "StopLossRate",
    "TakeProfitRate",
    "UnitsToDeduct",
})


def round_etoro_price(value: float | int | str | None) -> float | None:
    """Round monetary values sent to eToro to 2 decimal places."""
    if value is None:
        return None
    return round(float(value), 2)


def round_etoro_units(value: float | int | str | None) -> float | None:
    """Round position units to eToro's 6-decimal precision."""
    if value is None:
        return None
    return round(float(value), 6)


def normalize_etoro_order_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize outgoing eToro order payload money/price fields to 2 decimals."""
    normalized = dict(payload)
    for key in _ETORO_PRICE_KEYS:
        if key not in normalized or normalized[key] is None:
            continue
        try:
            normalized[key] = round_etoro_price(normalized[key])
        except (TypeError, ValueError):
            continue
    return normalized


def stop_loss_rate_from_amount(ltp: float, invested_amount: float, max_loss_amount: float) -> float:
    if invested_amount <= max_loss_amount:
        raise ValueError(
            f"Invested amount {invested_amount} must exceed max loss budget "
            f"({max_loss_amount}) to derive a stop-loss rate"
        )
    loss_fraction = max_loss_amount / float(invested_amount)
    return round(float(ltp) * (1 - loss_fraction), 4)


def compute_stop_loss_price(
    entry_price: float,
    invested_amount: float | None,
    *,
    stop_loss_amount: float | None,
    short_percent: float,
) -> float:
    """Derive stop-loss price from a fixed loss budget or fallback percent."""
    if (
        stop_loss_amount is not None
        and stop_loss_amount > 0
        and invested_amount is not None
        and invested_amount > stop_loss_amount
    ):
        return stop_loss_rate_from_amount(entry_price, invested_amount, stop_loss_amount)
    return round(float(entry_price) * (1 - float(short_percent) / 100), 2)


def resolve_bracket_stop_loss_rate(
    ltp: float | None,
    stop_loss_rate: float | None,
    *,
    invested_amount: float | None = None,
) -> float:
    """Return the stop-loss rate for a bracket order.

    When stop_loss_rate is omitted, derive it from a fixed max loss budget
    (DEFAULT_BRACKET_STOP_LOSS_AMOUNT in account currency) relative to the
    invested amount: loss_fraction = max_loss / invested_amount, then
    stop_loss_rate = ltp * (1 - loss_fraction).
    """
    if stop_loss_rate is not None:
        return float(stop_loss_rate)
    if ltp is None or ltp <= 0:
        raise ValueError("Bracket order requires a positive reference price when stop_loss_rate is omitted")
    if invested_amount is None or invested_amount <= 0:
        raise ValueError("Bracket order requires a positive invested amount when stop_loss_rate is omitted")
    return stop_loss_rate_from_amount(ltp, invested_amount, DEFAULT_BRACKET_STOP_LOSS_AMOUNT)


def apply_v1_bracket_fields(
    payload: dict[str, Any],
    *,
    stop_loss_rate: float,
    take_profit_rate: float | None,
    trailing_stop_loss: bool = False,
) -> dict[str, Any]:
    payload["StopLossRate"] = round_etoro_price(stop_loss_rate)
    payload["IsNoStopLoss"] = False
    payload["IsTslEnabled"] = bool(trailing_stop_loss)
    if take_profit_rate is not None:
        payload["TakeProfitRate"] = round_etoro_price(take_profit_rate)
        payload["IsNoTakeProfit"] = False
    else:
        payload["IsNoTakeProfit"] = True
    return payload


def apply_v2_bracket_fields(
    payload: dict[str, Any],
    *,
    stop_loss_rate: float,
    take_profit_rate: float | None,
    trailing_stop_loss: bool = False,
) -> dict[str, Any]:
    payload["stopLossRate"] = round_etoro_price(stop_loss_rate)
    if take_profit_rate is not None:
        payload["takeProfitRate"] = round_etoro_price(take_profit_rate)
    if trailing_stop_loss:
        payload["stopLossType"] = "trailing"
    return payload


def _float_or_zero(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_order_close_fulfilled(lookup: dict[str, Any] | None) -> bool:
    """Close order complete: positionsToClose empty and executions closed with 0 units."""
    if not isinstance(lookup, dict):
        return False

    positions_to_close = lookup.get("positionsToClose")
    if positions_to_close is None:
        positions_to_close = []
    executions = lookup.get("positionExecutions") or []
    if positions_to_close:
        return False
    if not executions:
        return False
    return all(
        str(execution.get("state", "")).lower() == "closed"
        and _float_or_zero(execution.get("remainingUnits")) == 0
        for execution in executions
    )


def is_order_entry_fulfilled(lookup: dict[str, Any] | None) -> bool:
    """Open/buy order executed with live position units."""
    if not isinstance(lookup, dict):
        return False

    action = (lookup.get("action") or "").lower()
    if action == "close":
        return is_order_close_fulfilled(lookup)

    status = lookup.get("status") or {}
    status_id = status.get("id")
    executions = lookup.get("positionExecutions") or []
    if executions:
        return any(
            str(execution.get("state", "")).lower() in {"open", "closed"}
            and _float_or_zero(execution.get("remainingUnits")) > 0
            for execution in executions
        )
    return status_id == 1


def _lookup_status(lookup: dict[str, Any]) -> dict[str, Any]:
    status = lookup.get("status")
    return status if isinstance(status, dict) else {}


def is_order_terminal_rejected(lookup: dict[str, Any] | None) -> bool:
    """True when v2 orders:lookup shows a terminal failure (not Filled/Executed)."""
    if not isinstance(lookup, dict):
        return False

    if is_order_entry_fulfilled(lookup) or is_order_close_fulfilled(lookup):
        return False

    status = _lookup_status(lookup)
    name = str(status.get("name") or "").strip().lower()
    if name in {"filled", "executed", "partially executed", "partially filled"}:
        return False

    error_code = status.get("errorCode")
    if error_code not in (None, 0):
        return True
    if name in {"cancelled", "canceled", "rejected"}:
        return True

    status_id = status.get("id")
    if status_id == 2:
        return True
    # v1 websocket/OpenAPI uses id=3 for Rejected; v2 lookup uses id=3 with name=Filled.
    if status_id == 3 and name in {"", "rejected"}:
        return True
    return False


def classify_order_poll_outcome(lookup: dict[str, Any] | None) -> str | None:
    """Return fulfilled, rejected, or None while the order is still pending."""
    if not isinstance(lookup, dict):
        return None

    action = (lookup.get("action") or "").lower()
    if action == "close":
        if is_order_close_fulfilled(lookup):
            return "fulfilled"
        if is_order_terminal_rejected(lookup):
            return "rejected"
        return None
    if is_order_entry_fulfilled(lookup):
        return "fulfilled"
    if is_order_close_fulfilled(lookup):
        return "fulfilled"
    if is_order_terminal_rejected(lookup):
        return "rejected"
    return None


def lookup_last_update(lookup: dict[str, Any] | None) -> str | None:
    if not isinstance(lookup, dict):
        return None
    value = lookup.get("lastUpdate") or lookup.get("last_update")
    return str(value) if value is not None else None


def normalize_position_executions(lookup: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(lookup, dict):
        return []

    normalized: list[dict[str, Any]] = []
    asset = lookup.get("asset") or {}
    for execution in lookup.get("positionExecutions") or []:
        position_id = execution.get("positionId") or execution.get("positionID")
        if position_id is None:
            continue
        normalized.append({
            "position_id": str(position_id),
            "state": str(execution.get("state") or "").lower(),
            "remaining_units": _float_or_zero(execution.get("remainingUnits")),
            "invested_amount": _float_or_zero(execution.get("investedAmountCurrency")),
            "stop_loss_rate": execution.get("stopLossRate"),
            "take_profit_rate": execution.get("takeProfitRate"),
            "instrument_id": asset.get("instrumentId") or asset.get("instrumentID"),
            "symbol": asset.get("symbol"),
            "raw": execution,
        })
    return normalized


def diff_position_executions(
    previous_lookup: dict[str, Any] | None,
    current_lookup: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    previous = {
        item["position_id"]: item
        for item in normalize_position_executions(previous_lookup)
    }
    current = {
        item["position_id"]: item
        for item in normalize_position_executions(current_lookup)
    }
    changes: list[dict[str, Any]] = []

    for position_id, current_position in current.items():
        previous_position = previous.get(position_id)
        if previous_position is None:
            changes.append({
                "change_type": "POSITION_OPENED",
                "position_id": position_id,
                "position": current_position,
            })
            continue

        state_changed = previous_position.get("state") != current_position.get("state")
        units_changed = previous_position.get("remaining_units") != current_position.get("remaining_units")
        if not state_changed and not units_changed:
            continue

        if current_position.get("state") == "closed":
            changes.append({
                "change_type": "POSITION_CLOSED",
                "position_id": position_id,
                "position": current_position,
                "previous": previous_position,
            })
        else:
            changes.append({
                "change_type": "POSITION_UPDATED",
                "position_id": position_id,
                "position": current_position,
                "previous": previous_position,
            })

    return changes


def positions_from_order_lookup(lookup: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return unique position payloads from a v2 orders:lookup response."""
    if not isinstance(lookup, dict):
        return []

    by_id: dict[str, dict[str, Any]] = {}
    for position in lookup.get("positions", []) or []:
        position_id = position.get("positionID") or position.get("positionId") or position.get("PositionID")
        if position_id is not None:
            by_id[str(position_id)] = position

    for execution in lookup.get("positionExecutions", []) or []:
        position_id = execution.get("positionId") or execution.get("positionID") or execution.get("PositionID")
        if position_id is not None:
            by_id.setdefault(str(position_id), execution)

    return list(by_id.values())


def position_ids_from_order_status(order_status: dict[str, Any] | None) -> list[str]:
    if not isinstance(order_status, dict):
        return []

    position_ids: list[str] = []
    for execution in order_status.get("positionExecutions", []) or []:
        position_id = execution.get("positionId") or execution.get("positionID")
        if position_id is not None:
            position_ids.append(str(position_id))

    if position_ids:
        return position_ids

    for position in order_status.get("positions", []) or []:
        position_id = position.get("positionID") or position.get("positionId")
        if position_id is not None:
            position_ids.append(str(position_id))
    return position_ids
