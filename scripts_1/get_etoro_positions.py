#!/usr/bin/env python3
"""Fetch open positions and pending orders from the eToro live account."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
import pprint
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from logzero import logger

from brokers.etoro.client import EtoroApiError
from brokers.etoro.trading_client import EtoroTradingClient


def _instrument_id(record: dict[str, Any]) -> int | None:
    raw = record.get("instrumentID") or record.get("instrumentId")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _position_pnl(position: dict[str, Any]) -> float | None:
    unrealized = position.get("unrealizedPnL")
    if isinstance(unrealized, dict):
        pnl = unrealized.get("pnL")
        return float(pnl) if pnl is not None else None
    if unrealized is not None:
        try:
            return float(unrealized)
        except (TypeError, ValueError):
            return None
    return None


def _format_position(position: dict[str, Any], symbol_map: dict[int, str]) -> str:
    instrument_id = _instrument_id(position)
    symbol = symbol_map.get(instrument_id, str(instrument_id or "?"))
    position_id = position.get("positionID") or position.get("positionId") or "?"
    side = "BUY" if position.get("isBuy", position.get("IsBuy", True)) else "SELL"
    units = position.get("units") or position.get("Units") or 0
    amount = position.get("amount") or position.get("Amount") or 0
    leverage = position.get("leverage") or position.get("Leverage") or 1
    open_rate = position.get("openRate") or position.get("OpenRate") or 0
    mirror_id = position.get("mirrorID") or position.get("mirrorId") or 0
    pnl = _position_pnl(position)
    pnl_text = f"${pnl:+.2f}" if pnl is not None else "n/a"
    copy_tag = f" copy(mirror={mirror_id})" if mirror_id else ""
    return (
        f"  {symbol:<12} pos={position_id}  {side:<4}  "
        f"units={units}  amount=${amount:.2f}  lev={leverage}x  "
        f"open={open_rate}  PnL={pnl_text}{copy_tag}"
    )


def _format_order(order: dict[str, Any], symbol_map: dict[int, str], *, kind: str) -> str:
    instrument_id = _instrument_id(order)
    symbol = symbol_map.get(instrument_id, str(instrument_id or "?"))
    order_id = order.get("orderID") or order.get("orderId") or "?"
    side = "BUY" if order.get("isBuy", order.get("IsBuy", True)) else "SELL"
    amount = order.get("amount") or order.get("Amount") or 0
    units = order.get("units") or order.get("Units")
    rate = order.get("rate") or order.get("Rate")
    parts = [f"  [{kind}] {symbol:<12} order={order_id}  {side:<4}  amount=${amount:.2f}"]
    if units is not None:
        parts.append(f"units={units}")
    if rate is not None:
        parts.append(f"rate={rate}")
    return "  ".join(parts)


async def fetch_account_snapshot(account_env: str) -> dict[str, Any]:
    client = EtoroTradingClient(account_env=account_env)
    client.generate_session()

    portfolio = await client.aget_client_portfolio()
    pprint.pprint(portfolio)
    orders_snapshot = await client.aget_orders_snapshot()
    pprint.pprint(orders_snapshot)
    positions = portfolio.get("positions", []) or []

    instrument_ids: list[int] = []
    seen: set[int] = set()
    for record in (
        positions
        + (orders_snapshot.get("orders") or [])
        + (orders_snapshot.get("orders_for_open") or [])
        + (orders_snapshot.get("orders_for_close") or [])
    ):
        instrument_id = _instrument_id(record)
        if instrument_id is not None and instrument_id not in seen:
            seen.add(instrument_id)
            instrument_ids.append(instrument_id)

    symbol_map = await client.aget_instrument_symbol_map(instrument_ids)

    return {
        "account_env": account_env,
        "api_env": client.env,
        "credit": portfolio.get("credit"),
        "unrealized_pnl": portfolio.get("unrealizedPnL"),
        "positions": positions,
        "orders": orders_snapshot.get("orders") or [],
        "orders_for_open": orders_snapshot.get("orders_for_open") or [],
        "orders_for_close": orders_snapshot.get("orders_for_close") or [],
        "symbol_map": symbol_map,
    }


def print_snapshot(snapshot: dict[str, Any], *, raw: bool) -> None:
    account_env = snapshot["account_env"]
    api_env = snapshot["api_env"]
    positions = snapshot["positions"]
    orders = snapshot["orders"]
    orders_for_open = snapshot["orders_for_open"]
    orders_for_close = snapshot["orders_for_close"]
    symbol_map = snapshot["symbol_map"]

    print(f"eToro account snapshot  profile={account_env}  api_env={api_env}")
    print(f"Available credit: {snapshot.get('credit')}")
    print(f"Portfolio unrealized PnL: {snapshot.get('unrealized_pnl')}")
    print()

    print(f"Open positions ({len(positions)})")
    if positions:
        for position in positions:
            print(_format_position(position, symbol_map))
    else:
        print("  (none)")

    pending_total = len(orders) + len(orders_for_open) + len(orders_for_close)
    print()
    print(f"Pending / active orders ({pending_total})")
    if orders_for_open:
        print("  ordersForOpen:")
        for order in orders_for_open:
            print(_format_order(order, symbol_map, kind="open"))
    if orders:
        print("  orders:")
        for order in orders:
            print(_format_order(order, symbol_map, kind="pending"))
    if orders_for_close:
        print("  ordersForClose:")
        for order in orders_for_close:
            print(_format_order(order, symbol_map, kind="close"))
    if pending_total == 0:
        print("  (none)")

    if raw:
        print()
        print("Raw JSON:")
        print(
            json.dumps(
                {
                    "positions": positions,
                    "orders": orders,
                    "ordersForOpen": orders_for_open,
                    "ordersForClose": orders_for_close,
                },
                indent=2,
                default=str,
            )
        )


async def main() -> int:
    parser = argparse.ArgumentParser(description="Get eToro open positions and pending orders.")
    parser.add_argument(
        "--env",
        default="live",
        choices=("live", "demo"),
        help="Account profile to load (.live.env or .demo.env). Default: live",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Also print the raw position/order JSON from eToro",
    )
    args = parser.parse_args()
    logger.setLevel(logging.WARNING)

    try:
        snapshot = await fetch_account_snapshot(args.env)
    except EtoroApiError as exc:
        print(f"eToro API error: {exc}", file=sys.stderr)
        if exc.payload:
            print(f"Details: {exc.payload}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    print_snapshot(snapshot, raw=args.raw)

    has_activity = bool(
        snapshot["positions"]
        or snapshot["orders"]
        or snapshot["orders_for_open"]
        or snapshot["orders_for_close"]
    )
    return 0 if has_activity else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
