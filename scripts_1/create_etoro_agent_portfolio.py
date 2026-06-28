#!/usr/bin/env python3
"""List or create eToro agent-portfolios (see openapi.json Agent Portfolios section).

Examples:
  python scripts_1/create_etoro_agent_portfolio.py --list
  python scripts_1/create_etoro_agent_portfolio.py --scopes
  python scripts_1/create_etoro_agent_portfolio.py --create \\
    --name DemoBot1 --investment 2000 --token-name demo-bot-token
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from logzero import logger

from brokers.etoro.agent_portfolios import (
    build_create_agent_portfolio_v2_payload,
    create_agent_portfolio_v2,
    default_agent_portfolio_scope_names,
    get_agent_portfolio_allowed_scopes,
    get_agent_portfolios,
    redact_agent_portfolio_response,
)
from brokers.etoro.client import EtoroApiError, EtoroClient


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logger.setLevel(level)


def _print_json(label: str, payload: object) -> None:
    print(f"\n{label}")
    print(json.dumps(payload, indent=2, default=str))


async def _run(args: argparse.Namespace) -> int:
    client = EtoroClient(args.account_env)

    if args.scopes:
        try:
            scopes = await get_agent_portfolio_allowed_scopes(client)
        except EtoroApiError as exc:
            print(f"Failed to load allowed scopes: {exc}", file=sys.stderr)
            if exc.status_code == 403:
                print(
                    "Hint: your API user token needs agent-portfolio permissions "
                    "(InsufficientPermissions).",
                    file=sys.stderr,
                )
            return 1
        _print_json("Allowed scope names (v2):", scopes)
        return 0

    if args.list or not args.create:
        try:
            portfolios = await get_agent_portfolios(client)
        except EtoroApiError as exc:
            print(f"Failed to list agent-portfolios: {exc}", file=sys.stderr)
            if exc.status_code == 403:
                print(
                    "Hint: your API user token needs agent-portfolio permissions "
                    "(InsufficientPermissions).",
                    file=sys.stderr,
                )
            return 1
        _print_json(f"Agent portfolios ({len(portfolios)}):", portfolios)
        if not args.create:
            return 0

    scope_names = (
        [part.strip() for part in args.scope.split(",") if part.strip()]
        if args.scope
        else default_agent_portfolio_scope_names(args.account_env)
    )

    try:
        payload = build_create_agent_portfolio_v2_payload(
            investment_amount_usd=args.investment,
            agent_portfolio_name=args.name,
            user_token_name=args.token_name,
            scope_names=scope_names,
            account_env=args.account_env,
            agent_portfolio_description=args.description,
        )
    except ValueError as exc:
        print(f"Invalid request: {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        _print_json("Dry run — would POST /api/v2/agent-portfolios with:", payload)
        return 0

    try:
        response = await create_agent_portfolio_v2(client, payload)
    except EtoroApiError as exc:
        print(f"Create failed: {exc}", file=sys.stderr)
        if exc.status_code == 403:
            print(
                "Hint: agent-portfolio create requires elevated eToro API permissions.",
                file=sys.stderr,
            )
        return 1

    print("\nAgent portfolio created.")
    print("Save any userToken values below — they are shown only once.\n")
    print(json.dumps(response, indent=2, default=str))
    print("\nRedacted (safe to share):")
    print(json.dumps(redact_agent_portfolio_response(response), indent=2, default=str))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage eToro agent-portfolios (OpenAPI v2 create)")
    parser.add_argument(
        "--account-env",
        "--account_env",
        default="demo",
        choices=["demo", "live"],
        help="Credential profile (.demo.env or .live.env)",
    )
    parser.add_argument("--list", action="store_true", help="List existing agent-portfolios")
    parser.add_argument("--scopes", action="store_true", help="List allowed user-token scope names")
    parser.add_argument("--create", action="store_true", help="Create a new agent-portfolio (v2)")
    parser.add_argument(
        "--name",
        default="DemoBot1",
        help="agentPortfolioName (6-10 characters, unique)",
    )
    parser.add_argument(
        "--investment",
        type=float,
        default=2000.0,
        help="investmentAmountInUsd copied from your account",
    )
    parser.add_argument(
        "--token-name",
        default="demo-bot-token",
        help="userTokenName for the provisioned token",
    )
    parser.add_argument("--description", default="", help="Optional agentPortfolioDescription")
    parser.add_argument(
        "--scope",
        default="",
        help="Comma-separated scopeNames (default: demo or real read+write pair)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print payload without calling eToro")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    _configure_logging(args.verbose)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
