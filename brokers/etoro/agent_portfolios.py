"""eToro agent-portfolio helpers (OpenAPI: /api/v1|v2/agent-portfolios)."""

from __future__ import annotations

from typing import Any

from brokers.etoro.client import EtoroClient
from brokers.etoro.env import normalize_etoro_api_env

AGENT_PORTFOLIO_NAME_MIN = 6
AGENT_PORTFOLIO_NAME_MAX = 10

DEMO_SCOPE_NAMES = (
    "etoro-public:trade.demo:read",
    "etoro-public:trade.demo:write",
)
REAL_SCOPE_NAMES = (
    "etoro-public:trade.real:read",
    "etoro-public:trade.real:write",
)


def validate_agent_portfolio_name(name: str) -> str:
    trimmed = name.strip()
    length = len(trimmed)
    if length < AGENT_PORTFOLIO_NAME_MIN or length > AGENT_PORTFOLIO_NAME_MAX:
        raise ValueError(
            f"agentPortfolioName must be {AGENT_PORTFOLIO_NAME_MIN}-{AGENT_PORTFOLIO_NAME_MAX} characters "
            f"(got {length})",
        )
    return trimmed


def default_agent_portfolio_scope_names(account_env: str | None) -> list[str]:
    api_env = normalize_etoro_api_env(account_env)
    if api_env == "demo":
        return list(DEMO_SCOPE_NAMES)
    return list(REAL_SCOPE_NAMES)


def build_create_agent_portfolio_v2_payload(
    *,
    investment_amount_usd: float,
    agent_portfolio_name: str,
    user_token_name: str,
    scope_names: list[str] | None = None,
    account_env: str | None = None,
    agent_portfolio_description: str | None = None,
    ips_whitelist: list[str] | None = None,
    expires_at: str | None = None,
) -> dict[str, Any]:
    if investment_amount_usd <= 0:
        raise ValueError("investmentAmountInUsd must be positive")

    token_name = user_token_name.strip()
    if not token_name:
        raise ValueError("userTokenName is required")

    scopes = scope_names or default_agent_portfolio_scope_names(account_env)
    if not scopes:
        raise ValueError("scopeNames must not be empty")

    payload: dict[str, Any] = {
        "investmentAmountInUsd": float(investment_amount_usd),
        "agentPortfolioName": validate_agent_portfolio_name(agent_portfolio_name),
        "userTokenName": token_name,
        "scopeNames": scopes,
    }
    if agent_portfolio_description:
        payload["agentPortfolioDescription"] = agent_portfolio_description.strip()
    if ips_whitelist:
        payload["ipsWhitelist"] = ips_whitelist
    if expires_at:
        payload["expiresAt"] = expires_at
    return payload


async def get_agent_portfolios(client: EtoroClient) -> list[dict[str, Any]]:
    response = await client.arequest("GET", "/agent-portfolios")
    if isinstance(response, dict):
        portfolios = response.get("agentPortfolios")
        return portfolios if isinstance(portfolios, list) else []
    return []


async def get_agent_portfolio_allowed_scopes(client: EtoroClient) -> list[str]:
    response = await client.arequest_v2("GET", "/agent-portfolios/user-tokens/scopes")
    if not isinstance(response, dict):
        return []

    scopes = response.get("scopes")
    if not isinstance(scopes, list):
        return []

    names: list[str] = []
    for item in scopes:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            name = item.get("scopeName") or item.get("name")
            if name:
                names.append(str(name))
    return names


async def create_agent_portfolio_v2(
    client: EtoroClient,
    payload: dict[str, Any],
) -> dict[str, Any]:
    response = await client.arequest_v2("POST", "/agent-portfolios", json_body=payload)
    return response if isinstance(response, dict) else {"data": response}


def redact_agent_portfolio_response(response: dict[str, Any]) -> dict[str, Any]:
    """Return a copy safe to log (masks one-time user token secrets)."""
    redacted = dict(response)
    tokens = redacted.get("userTokens")
    if isinstance(tokens, list):
        redacted["userTokens"] = [
            {
                **token,
                "userToken": "***redacted***" if token.get("userToken") else token.get("userToken"),
            }
            if isinstance(token, dict)
            else token
            for token in tokens
        ]
    return redacted
