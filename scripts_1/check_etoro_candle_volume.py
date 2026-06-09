#!/usr/bin/env python3
"""Temporary probe: eToro 1-minute candles raw response + volume fields."""

from __future__ import annotations

import asyncio
import json
import sys

_repo = __import__("pathlib").Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_repo))

from brokers.etoro.candles import aget_historical_candles, extract_etoro_candles, normalize_etoro_candle
from brokers.etoro.trading_client import EtoroTradingClient


async def main() -> None:
    symbol = sys.argv[1] if len(sys.argv) > 1 else "BTC"
    token = sys.argv[2] if len(sys.argv) > 2 else None
    account_env = sys.argv[3] if len(sys.argv) > 3 else "demo"
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 10

    client = EtoroTradingClient(account_env=account_env)
    client.generate_session()

    instrument_id = await client._instrument_id(symbol, token)
    if instrument_id is None:
        print(f"ERROR: could not resolve instrument for symbol={symbol} token={token}")
        return

    path = f"/market-data/instruments/{instrument_id}/history/candles/desc/OneMinute/{count}"
    raw = await client.arequest("GET", path)
    print("=== RAW RESPONSE TOP KEYS ===")
    print(list(raw.keys()) if isinstance(raw, dict) else type(raw))

    rows = (
        raw.get("candles")
        or raw.get("Candles")
        or raw.get("items")
        or raw.get("data")
        or []
    ) if isinstance(raw, dict) else []
    print(f"=== ROW COUNT: {len(rows)} ===")
    if rows:
        print("=== FIRST ROW KEYS ===")
        print(list(rows[0].keys()) if isinstance(rows[0], dict) else rows[0])
        print("=== FIRST ROW (pretty) ===")
        print(json.dumps(rows[0], indent=2, default=str))
        print("=== LAST ROW (pretty) ===")
        print(json.dumps(rows[-1], indent=2, default=str))

    normalized = extract_etoro_candles(raw)
    print(f"=== NORMALIZED COUNT: {len(normalized)} ===")
    if normalized:
        print("=== LAST 3 NORMALIZED ===")
        for candle in normalized[-3:]:
            print(candle)

    print("=== VOLUME SUMMARY ===")
    volumes = [float(c.get("volume") or 0) for c in normalized]
    non_zero = [v for v in volumes if v > 0]
    print(f"total={len(volumes)} non_zero={len(non_zero)} max={max(volumes) if volumes else 0}")
    if non_zero:
        print(f"sample_non_zero={non_zero[:5]}")
    else:
        print("NOTE: eToro returned null/0 volume on all per-minute bars for this instrument.")
        print("      Crypto (BTC) often has no minute volume; equities (AAPL) usually do.")
        if rows and isinstance(rows[0], dict):
            nested = rows[0].get("candles") or rows[0].get("Candles") or []
            if nested and isinstance(nested[0], dict):
                print(f"      sample nested volume field: {nested[0].get('volume')!r}")


if __name__ == "__main__":
    asyncio.run(main())
