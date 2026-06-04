"""Human-readable Telegram message formatting for platform events."""

from __future__ import annotations

from typing import Any

from utils import order_quantity_from_capital

_ACTION_LABELS = {
    "STRATEGY_CREATED": "Strategy created",
    "STRATEGY_SCHEDULED": "Strategy scheduled",
    "STRATEGY_DEPLOYED": "Strategy deployed",
    "STRATEGY_RUNNING": "Strategy running",
    "STRATEGY_STOPPED": "Strategy stopped",
    "STRATEGY_CANCELLED": "Strategy cancelled",
    "STRATEGY_UNSCHEDULED": "Strategy unscheduled",
    "BUY_ORDER_PLACED": "Buy order placed",
    "SELL_ORDER_PLACED": "Sell order placed",
    "ORDER_FILLED": "Order filled",
    "ORDER_CANCELLED": "Order cancelled",
    "ORDER_REJECTED": "Order rejected",
    "ORDER_OPEN": "Order open",
    "ORDER_PENDING": "Order pending",
    "ORDER_MODIFIED": "Order modified",
    "POSITION_CLOSED": "Position closed",
    "TAKE_PROFIT_EXIT_PLACED": "Take-profit exit",
    "STOP_LOSS_EXIT_PLACED": "Stop-loss exit",
    "take_profit_triggered": "Take profit triggered",
    "stop_loss_triggered": "Stop loss triggered",
}

_STATE_EMOJI = {
    "pending": "📝",
    "scheduled": "⏰",
    "starting": "🔄",
    "running": "🟢",
    "stopped": "⏹",
    "stale": "⚠️",
    "cancelled": "❌",
}


def _float(value: Any, default: float | None = None) -> float | None:
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not (parsed == parsed):  # NaN
        return default
    return parsed


def _is_inr_broker(broker: str | None) -> bool:
    return str(broker or "angel").lower() in {"angel", "fake"}


def format_money(broker: str | None, value: float | None, *, signed: bool = False) -> str:
    if value is None:
        return "—"
    prefix = ""
    if signed and value > 0:
        prefix = "+"
    elif signed and value < 0:
        prefix = ""
    amount = abs(value) if signed else value
    if _is_inr_broker(broker):
        return f"{prefix}₹{amount:,.2f}"
    return f"{prefix}${amount:,.2f}"


def format_pct(value: float | None, *, signed: bool = False) -> str:
    if value is None:
        return "—"
    if signed and value > 0:
        return f"+{value:.2f}%"
    if signed and value < 0:
        return f"{value:.2f}%"
    return f"{value:.2f}%"


def build_strategy_plan(
    *,
    broker: str | None,
    executor: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Derive display amounts from saved strategy parameters (at ref. close)."""
    close = _float(executor.get("close_price") or config.get("close_price"))
    long_pct = _float(executor.get("long_percent") or config.get("long_percent"), 1.0) or 1.0
    short_pct = _float(executor.get("short_percent") or config.get("short_percent"), 10.0) or 10.0
    entry_threshold = _float(
        executor.get("initial_threshold") or config.get("initial_threshold"),
        0.2,
    ) or 0.2
    capital = _float(
        executor.get("max_available_capital") or config.get("max_available_capital"),
    )
    allow_partial = bool(
        executor.get("allow_partial_stocks")
        if executor.get("allow_partial_stocks") is not None
        else config.get("allow_partial_stocks")
    )
    strategy_type = (
        executor.get("strategy_type")
        or config.get("strategy_type")
        or config.get("strategy_name")
    )
    tick_sample = executor.get("tick_sample_every") or config.get("tick_sample_every")

    plan: dict[str, Any] = {
        "long_percent": long_pct,
        "short_percent": short_pct,
        "initial_threshold": entry_threshold,
        "max_available_capital": capital,
        "allow_partial_stocks": allow_partial,
        "strategy_type": strategy_type,
        "tick_sample_every": tick_sample,
        "reference_close": close,
    }

    if close is None or close <= 0:
        return plan

    tp_price = round(close * (1 + long_pct / 100), 2)
    sl_price = round(close * (1 - short_pct / 100), 2)
    qty = 0.0
    if capital and capital > 0:
        qty = order_quantity_from_capital(capital, close, allow_partial=allow_partial)

    invested = round(qty * close, 2) if qty else None
    profit_amt = round(qty * (tp_price - close), 2) if qty else None
    loss_amt = round(qty * (close - sl_price), 2) if qty else None

    plan.update(
        {
            "take_profit_price": tp_price,
            "stop_loss_price": sl_price,
            "estimated_quantity": qty if qty else None,
            "estimated_invested": invested,
            "estimated_profit_at_tp": profit_amt,
            "estimated_loss_at_sl": loss_amt,
            "entry_trigger_label": f"{format_pct(entry_threshold, signed=True)} vs ref. close",
        }
    )
    return plan


def enrich_strategy_details(
    details: dict[str, Any],
    *,
    executor: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    broker = details.get("broker")
    plan = build_strategy_plan(broker=broker, executor=executor, config=config)
    merged = {**details}
    for key, value in plan.items():
        if value is not None and merged.get(key) is None:
            merged[key] = value
    return merged


def _escape_html(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _format_two_column_table(rows: list[tuple[str, str]], *, label_width: int = 15) -> str:
    """Plain-text rows for a fixed-width label | value table."""
    lines: list[str] = []
    for label, value in rows:
        if not label and not value:
            lines.append("")
            continue
        if not value:
            continue
        lines.append(f"{label:<{label_width}} {value}")
    return "\n".join(lines)


def _section_break(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    if rows and rows[-1] != ("", ""):
        rows.append(("", ""))
    return rows


def format_strategy_telegram_message(action: str, details: dict[str, Any]) -> str:
    label = _ACTION_LABELS.get(action, action.replace("_", " ").title())
    state = str(details.get("state") or "").lower()
    state_emoji = _STATE_EMOJI.get(state, "📌")
    broker = details.get("broker")
    symbol = details.get("symbol") or "—"
    exchange = details.get("exchange") or ""
    account_env = details.get("account_env") or ""

    rows: list[tuple[str, str]] = [
        ("Symbol", f"{symbol}" + (f" · {exchange}" if exchange else "")),
        (
            "Broker",
            f"{broker or '—'}" + (f" · {account_env}" if account_env else ""),
        ),
    ]

    strategy_type = details.get("strategy_type") or details.get("strategy_name")
    if strategy_type:
        rows.append(("Algo", str(strategy_type)))

    if details.get("state"):
        status = str(details["state"])
        if details.get("previous_state"):
            status += f" (was {details['previous_state']})"
        rows.append(("Status", f"{state_emoji} {status}"))

    capital = _float(details.get("max_available_capital"))
    ref_close = _float(details.get("reference_close"))
    if capital is not None or ref_close is not None or details.get("entry_trigger_label"):
        rows = _section_break(rows)
        if capital is not None:
            rows.append(("Capital", format_money(broker, capital)))
        if ref_close is not None:
            rows.append(("Ref. close", format_money(broker, ref_close)))
        if details.get("entry_trigger_label"):
            rows.append(("Entry when", str(details["entry_trigger_label"])))
        elif details.get("initial_threshold") is not None:
            rows.append(
                (
                    "Entry when",
                    f"{format_pct(_float(details.get('initial_threshold')), signed=True)} vs ref. close",
                )
            )

    long_pct = _float(details.get("long_percent"))
    short_pct = _float(details.get("short_percent"))
    tp_price = _float(details.get("take_profit_price"))
    sl_price = _float(details.get("stop_loss_price"))
    if long_pct is not None and tp_price is not None:
        rows = _section_break(rows)
        profit_est = _float(details.get("estimated_profit_at_tp"))
        tp_value = f"{format_pct(long_pct, signed=True)} · {format_money(broker, tp_price)}"
        if profit_est is not None:
            tp_value += f" · {format_money(broker, profit_est, signed=True)} est."
        rows.append(("Take profit", tp_value))
    if short_pct is not None and sl_price is not None:
        if not (long_pct is not None and tp_price is not None):
            rows = _section_break(rows)
        loss_est = _float(details.get("estimated_loss_at_sl"))
        sl_value = f"{format_pct(-abs(short_pct))} · {format_money(broker, sl_price)}"
        if loss_est is not None:
            sl_value += f" · {format_money(broker, loss_est)} est."
        rows.append(("Stop loss", sl_value))

    qty = _float(details.get("estimated_quantity"))
    invested = _float(details.get("estimated_invested"))
    if qty or invested:
        rows = _section_break(rows)
        if qty and invested:
            rows.append(("Est. size", f"{qty:g} units · {format_money(broker, invested)}"))
        elif qty:
            rows.append(("Est. size", f"{qty:g} units"))
        elif invested:
            rows.append(("Est. invested", format_money(broker, invested)))

    if details.get("scheduled_start_at"):
        rows = _section_break(rows)
        rows.append(("Starts", str(details["scheduled_start_at"])))
        if details.get("schedule_label"):
            rows.append(("Schedule", str(details["schedule_label"])))
        if details.get("trading_day"):
            rows.append(("Trading day", str(details["trading_day"])))

    if details.get("trigger"):
        rows = _section_break(rows)
        rows.append(("Trigger", str(details["trigger"])))

    execution_id = details.get("execution_id")
    if execution_id:
        if not details.get("trigger"):
            rows = _section_break(rows)
        rows.append(("ID", str(execution_id)))

    table = _format_two_column_table(rows)
    title = _escape_html(f"{state_emoji} {label}")
    body = _escape_html(table)
    return f"<b>{title}</b>\n\n<pre>{body}</pre>"


def format_order_telegram_message(
    action: str,
    order_id: str | None,
    details: dict[str, Any],
) -> str:
    label = _ACTION_LABELS.get(action, action.replace("_", " ").title())
    broker = details.get("broker")
    symbol = details.get("symbol")

    lines = [
        "──────────────────────",
        f"📈 {label}",
        "──────────────────────",
    ]
    if symbol:
        lines.append(f"{symbol}" + (f" · {details.get('exchange')}" if details.get("exchange") else ""))
    if order_id:
        lines.append(f"Order {order_id}")
    if details.get("executor_id"):
        lines.append(f"Executor {details['executor_id']}")
    if details.get("position_id"):
        lines.append(f"Position {details['position_id']}")

    qty = _float(details.get("quantity"))
    entry = _float(details.get("entry_price"))
    if qty is not None or entry is not None:
        lines.append("")
        if qty is not None and entry is not None:
            lines.append(f"Fill {qty:g} @ {format_money(broker, entry)}")
            invested = qty * entry
            lines.append(f"Notional {format_money(broker, invested)}")
        elif entry is not None:
            lines.append(f"Price {format_money(broker, entry)}")

    tp = _float(details.get("take_profit_price"))
    sl = _float(details.get("stop_loss_price"))
    if tp is not None or sl is not None:
        lines.append("")
        if tp is not None:
            lines.append(f"TP {format_money(broker, tp)}")
        if sl is not None:
            lines.append(f"SL {format_money(broker, sl)}")

    exit_price = _float(details.get("exit_price"))
    if exit_price is not None:
        lines.append(f"Exit {format_money(broker, exit_price)}")

    end_rate = _float(details.get("end_rate"))
    if end_rate is not None:
        lines.append(f"Fill rate {format_money(broker, end_rate)}")

    reason = details.get("reason") or details.get("close_reason") or details.get("trigger_type")
    if reason:
        lines.append(f"Reason {reason}")

    if details.get("error_code"):
        lines.append(f"Error {details['error_code']}")

    return "\n".join(lines)


def format_telegram_event(
    order_id: str | None,
    action: str,
    details: dict[str, Any],
) -> str:
    from event.strategy_events import STRATEGY_LIFECYCLE_ACTIONS

    if action in STRATEGY_LIFECYCLE_ACTIONS:
        return format_strategy_telegram_message(action, details)
    return format_order_telegram_message(action, order_id, details)
