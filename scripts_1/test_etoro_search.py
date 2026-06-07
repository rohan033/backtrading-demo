#!/usr/bin/env python3
"""Direct eToro /market-data/search smoke test using requests.

Usage:
    .ven/bin/python scripts/test_etoro_search.py BTC
    .ven/bin/python scripts/test_etoro_search.py AAPL --profile live.read
"""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

import requests
from dotenv import dotenv_values


REPO_ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://public-api.etoro.com/api/v1"
SEARCH_URL = f"{BASE_URL}/market-data/search"


def main() -> int:
    parser = argparse.ArgumentParser(description="Test eToro /market-data/search")
    parser.add_argument("symbol", nargs="?", default="BTC", help="Symbol to search, e.g. BTC, AAPL")
    parser.add_argument(
        "--profile",
        default="live.read",
        help="Env profile to load: live.read, live, demo, or a custom env-file path",
    )
    args = parser.parse_args()

    config = load_profile(args.profile)
    api_key = config.get("ETORO_API_KEY")
    user_key = config.get("ETORO_USER_KEY") or config.get("ETORO_ACCOUNT_ID")
    access_token = config.get("ETORO_ACCESS_TOKEN")

    diagnostics = {
        "profile": args.profile,
        "env_file": str(profile_path(args.profile)),
        "url": SEARCH_URL,
        "has_api_key": bool(api_key),
        "has_user_key": bool(user_key),
        "has_access_token": bool(access_token),
    }
    print("Diagnostics:")
    print(json.dumps(diagnostics, indent=2))

    headers = {
        "User-Agent": "python-requests/2.33.1",
        "x-request-id": str(uuid.uuid4()),
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    else:
        headers["x-api-key"] = api_key or ""
        headers["x-user-key"] = user_key or ""

    response = requests.get(
        SEARCH_URL,
        headers=headers,
        params={"internalSymbolFull": args.symbol},
        timeout=float(config.get("ETORO_TIMEOUT_SECONDS", "20")),
    )

    print("\nResponse:")
    print(json.dumps({
        "status_code": response.status_code,
        "content_type": response.headers.get("content-type"),
    }, indent=2))

    try:
        payload = response.json()
    except ValueError:
        payload = response.text

    if not response.ok:
        print("\nError payload:")
        print(json.dumps(payload, indent=2, default=str))
        return 1

    rows = []
    if isinstance(payload, dict):
        rows = payload.get("items") or payload.get("instruments") or payload.get("data") or []
    if isinstance(rows, dict):
        rows = [rows]

    print(f"\nFound {len(rows)} result(s) for {args.symbol!r}.")
    for row in rows[:10]:
        print(json.dumps({
            "instrumentId": row.get("instrumentId") or row.get("instrumentID") or row.get("InstrumentID"),
            "internalSymbolFull": row.get("internalSymbolFull"),
            "symbolFull": row.get("symbolFull"),
            "displayName": row.get("displayName") or row.get("instrumentDisplayName"),
            "exchange": row.get("exchangeName") or row.get("exchange") or row.get("exchangeCode"),
        }, indent=2, default=str))

    return 0


def profile_path(profile: str) -> Path:
    selected = profile.lower()
    if selected in {"live.read", "live-read", "live_read"}:
        return REPO_ROOT / "live.read.env"
    if selected == "live":
        return REPO_ROOT / ".live.env"
    if selected == "demo":
        return REPO_ROOT / ".demo.env"
    return Path(profile).expanduser()


def load_profile(profile: str) -> dict[str, str]:
    return {
        key: value
        for key, value in dotenv_values(profile_path(profile)).items()
        if value is not None
    }


if __name__ == "__main__":
    raise SystemExit(main())
