from brokers.etoro.agent_portfolios import (
    AGENT_PORTFOLIO_NAME_MAX,
    AGENT_PORTFOLIO_NAME_MIN,
    build_create_agent_portfolio_v2_payload,
    default_agent_portfolio_scope_names,
    validate_agent_portfolio_name,
)


def test_validate_agent_portfolio_name_accepts_valid_length():
    assert validate_agent_portfolio_name("DemoBot1") == "DemoBot1"


def test_validate_agent_portfolio_name_rejects_short_name():
    try:
        validate_agent_portfolio_name("Bot1")
    except ValueError as exc:
        assert str(AGENT_PORTFOLIO_NAME_MIN) in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_validate_agent_portfolio_name_rejects_long_name():
    try:
        validate_agent_portfolio_name("A" * (AGENT_PORTFOLIO_NAME_MAX + 1))
    except ValueError as exc:
        assert str(AGENT_PORTFOLIO_NAME_MAX) in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_default_scope_names_for_demo_and_live():
    assert "demo" in default_agent_portfolio_scope_names("demo")[0]
    assert "real" in default_agent_portfolio_scope_names("live")[0]


def test_build_create_agent_portfolio_v2_payload():
    payload = build_create_agent_portfolio_v2_payload(
        investment_amount_usd=1500,
        agent_portfolio_name="MyPort01",
        user_token_name="my-token",
        account_env="demo",
        agent_portfolio_description="Test portfolio",
    )
    assert payload["investmentAmountInUsd"] == 1500
    assert payload["agentPortfolioName"] == "MyPort01"
    assert payload["userTokenName"] == "my-token"
    assert payload["scopeNames"] == default_agent_portfolio_scope_names("demo")
    assert payload["agentPortfolioDescription"] == "Test portfolio"
