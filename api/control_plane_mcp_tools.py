"""Friendly FastMCP tool names and agent hints for the control plane."""

from __future__ import annotations

import re

CONTROL_PLANE_MCP_SERVER = "backtrading-control-plane"

# Strategy / execution tools (saved controlled executions)
CREATE_STRATEGY_TOOL = "create_strategy"
GET_STRATEGIES_TOOL = "get_strategies"
GET_STRATEGY_TOOL = "get_strategy"
START_STRATEGY_TOOL = "start_strategy"
STOP_STRATEGY_TOOL = "stop_strategy"
UNSCHEDULE_STRATEGY_TOOL = "unschedule_strategy"
UNSCHEDULE_ALL_STRATEGIES_TOOL = "unschedule_all_strategies"
STOP_ALL_STRATEGIES_TOOL = "stop_all_strategies"
GET_STRATEGY_DUPLICATE_TEMPLATE_TOOL = "get_strategy_duplicate_template"
GET_DEFAULT_STRATEGY_SCHEDULE_TOOL = "get_default_strategy_schedule"
GET_TRADING_DAY_OPTIONS_TOOL = "get_trading_day_options"

# Engine / runtime read tools
GET_ENGINES_TOOL = "get_engines"
GET_ENGINE_TOOL = "get_engine"
GET_ENGINE_LOGS_TOOL = "get_engine_logs"

# Market / portfolio read tools
SEARCH_INSTRUMENTS_TOOL = "search_instruments"
GET_PORTFOLIO_TOOL = "get_portfolio"
SEARCH_SCRIP_TOOL = "search_scrip"
GET_ACCOUNT_PORTFOLIO_TOOL = "get_account_portfolio"
GET_HISTORICAL_CANDLES_TOOL = "get_historical_candles"

# Live event read tools
GET_CONTROL_EVENTS_TOOL = "get_control_events"
GET_CONTROL_TRADES_TOOL = "get_control_trades"
GET_CONTROL_ORDERS_TOOL = "get_control_orders"
GET_EVENT_SESSIONS_TOOL = "get_event_sessions"
GET_EVENT_SESSION_EVENTS_TOOL = "get_event_session_events"

# AI research read tools
GET_RESEARCH_SESSIONS_TOOL = "get_research_sessions"
GET_RESEARCH_SESSION_TOOL = "get_research_session"
GET_RESEARCH_MESSAGES_TOOL = "get_research_messages"

STRATEGY_MCP_TOOLS = (
    CREATE_STRATEGY_TOOL,
    GET_STRATEGIES_TOOL,
    GET_STRATEGY_TOOL,
    START_STRATEGY_TOOL,
    STOP_STRATEGY_TOOL,
    UNSCHEDULE_STRATEGY_TOOL,
    UNSCHEDULE_ALL_STRATEGIES_TOOL,
    STOP_ALL_STRATEGIES_TOOL,
    GET_STRATEGY_DUPLICATE_TEMPLATE_TOOL,
    GET_DEFAULT_STRATEGY_SCHEDULE_TOOL,
)

READ_MCP_TOOLS = (
    GET_STRATEGIES_TOOL,
    GET_STRATEGY_TOOL,
    GET_STRATEGY_DUPLICATE_TEMPLATE_TOOL,
    GET_DEFAULT_STRATEGY_SCHEDULE_TOOL,
    GET_TRADING_DAY_OPTIONS_TOOL,
    GET_ENGINES_TOOL,
    GET_ENGINE_TOOL,
    GET_ENGINE_LOGS_TOOL,
    SEARCH_INSTRUMENTS_TOOL,
    GET_PORTFOLIO_TOOL,
    SEARCH_SCRIP_TOOL,
    GET_ACCOUNT_PORTFOLIO_TOOL,
    GET_HISTORICAL_CANDLES_TOOL,
    GET_CONTROL_EVENTS_TOOL,
    GET_CONTROL_TRADES_TOOL,
    GET_CONTROL_ORDERS_TOOL,
    GET_EVENT_SESSIONS_TOOL,
    GET_EVENT_SESSION_EVENTS_TOOL,
    GET_RESEARCH_SESSIONS_TOOL,
    GET_RESEARCH_SESSION_TOOL,
    GET_RESEARCH_MESSAGES_TOOL,
)

READ_MCP_TOOL_NAMES = frozenset(READ_MCP_TOOLS)

MCP_MUTATION_TOOL_NAMES = frozenset({
    CREATE_STRATEGY_TOOL,
    START_STRATEGY_TOOL,
    STOP_STRATEGY_TOOL,
    UNSCHEDULE_STRATEGY_TOOL,
    UNSCHEDULE_ALL_STRATEGIES_TOOL,
    STOP_ALL_STRATEGIES_TOOL,
    "stop_engine",
    "delete_engine",
    "register_engine",
    "update_engine",
    "record_engine_heartbeat",
    "create_research_session",
    "update_research_session",
    "append_research_message",
    "upsert_research_action",
    "delete_research_action",
})


def normalize_mcp_tool_name(tool_name: str) -> str:
    return tool_name.lower().replace("-", "_").split(".")[-1]


def is_read_mcp_tool_name(tool_name: str) -> bool:
    normalized = normalize_mcp_tool_name(tool_name)
    if normalized in READ_MCP_TOOL_NAMES:
        return True
    return normalized.startswith("get_") or normalized.startswith("search_")


def is_mutation_mcp_tool_name(tool_name: str) -> bool:
    return normalize_mcp_tool_name(tool_name) in MCP_MUTATION_TOOL_NAMES


CONTROL_PLANE_HTTP_SHELL_RE = re.compile(
    r"/api/control/|127\.0\.0\.1:8000|localhost:8000",
    re.IGNORECASE,
)

CREATE_STRATEGY_TOOL_RE = re.compile(
    r"|".join(
        [
            re.escape(CREATE_STRATEGY_TOOL),
            r"create_controlled_execution",
            r"post_api_control_executions",
            r"/api/control/executions",
        ]
    ),
    re.IGNORECASE,
)

EXECUTE_CONTROL_PLANE_MCP_HINT = f"""Control plane actions (Execute mode — MCP only):
- Use `{CONTROL_PLANE_MCP_SERVER}` MCP tools for every control-plane operation. Do NOT use shell, curl, wget, httpx CLI, or other raw HTTP to hit `/api/control/` or other local API URLs.
- Read first with GET tools when you need context: `{GET_STRATEGIES_TOOL}`, `{GET_STRATEGY_TOOL}`, `{GET_ENGINES_TOOL}`, `{GET_ENGINE_TOOL}`, `{GET_PORTFOLIO_TOOL}`, `{SEARCH_INSTRUMENTS_TOOL}`, `{GET_CONTROL_EVENTS_TOOL}`, `{GET_CONTROL_TRADES_TOOL}`, `{GET_CONTROL_ORDERS_TOOL}`, `{GET_RESEARCH_SESSIONS_TOOL}`, `{GET_RESEARCH_SESSION_TOOL}`, `{GET_RESEARCH_MESSAGES_TOOL}`, `{GET_HISTORICAL_CANDLES_TOOL}`.
- Mutate with POST tools: `{CREATE_STRATEGY_TOOL}`, `{START_STRATEGY_TOOL}`, `{STOP_STRATEGY_TOOL}`, `{UNSCHEDULE_STRATEGY_TOOL}`, `{UNSCHEDULE_ALL_STRATEGIES_TOOL}`, `{STOP_ALL_STRATEGIES_TOOL}`.
- Scheduling helpers: `{GET_DEFAULT_STRATEGY_SCHEDULE_TOOL}`, `{GET_TRADING_DAY_OPTIONS_TOOL}`, `{GET_STRATEGY_DUPLICATE_TEMPLATE_TOOL}`.
- When calling `{CREATE_STRATEGY_TOOL}`, always include source_id in the JSON body:
  - "ai_chatbot_panel" for the floating Strategy AI panel (leave source_meta_id blank)
  - "ai_research" for an active AI Research session (MUST set source_meta_id to that session id)
  - "user" for manual/user flows (leave source_meta_id blank)"""

ASK_CONTROL_PLANE_READ_MCP_HINT = f"""Read-only control plane data (Ask mode):
- Use `{CONTROL_PLANE_MCP_SERVER}` MCP read tools (`get_*` and `search_*`) to inspect saved strategies, engines, portfolio, live events, and research sessions.
- Do NOT use shell, curl, wget, httpx CLI, or other raw HTTP to hit `/api/control/` or other local API URLs.
- Do NOT use MCP tools that create, start, stop, schedule, or mutate strategies/engines. Switch to Execute mode for those actions."""

MCP_TOOL_DESCRIPTIONS: dict[str, str] = {
    CREATE_STRATEGY_TOOL: "Create a saved strategy execution in the control plane.",
    GET_STRATEGIES_TOOL: "List saved strategy executions and their engine status.",
    GET_STRATEGY_TOOL: "Get one saved strategy execution by execution_id.",
    START_STRATEGY_TOOL: "Deploy/start a saved strategy execution live.",
    STOP_STRATEGY_TOOL: "Stop a running saved strategy execution.",
    UNSCHEDULE_STRATEGY_TOOL: "Remove the schedule from one saved strategy execution.",
    UNSCHEDULE_ALL_STRATEGIES_TOOL: "Unschedule every scheduled saved strategy execution.",
    STOP_ALL_STRATEGIES_TOOL: "Stop every running saved strategy execution.",
    GET_STRATEGY_DUPLICATE_TEMPLATE_TOOL: "Get a copy-ready payload from an existing strategy.",
    GET_DEFAULT_STRATEGY_SCHEDULE_TOOL: "Get the default schedule window for a broker.",
    GET_TRADING_DAY_OPTIONS_TOOL: "List upcoming trading-day schedule options for a broker.",
    GET_ENGINES_TOOL: "List data-plane engines registered with the control plane.",
    GET_ENGINE_TOOL: "Get one data-plane engine by id.",
    GET_ENGINE_LOGS_TOOL: "Get log file metadata for one data-plane engine.",
    SEARCH_INSTRUMENTS_TOOL: "Search broker instruments/symbols via the control plane.",
    GET_PORTFOLIO_TOOL: "Fetch portfolio/holdings for a broker via the control plane.",
    "get_etoro_positions": "Fetch open eToro positions for demo or live via GET /trading/info/{env}/pnl.",
    "get_etoro_orders": "Fetch eToro pending orders (open, close, limit) for demo or live via GET /trading/info/{env}/pnl.",
    SEARCH_SCRIP_TOOL: "Search NSE/BSE scrip symbols and tokens.",
    GET_ACCOUNT_PORTFOLIO_TOOL: "Fetch Angel account holdings from the legacy portfolio endpoint.",
    GET_HISTORICAL_CANDLES_TOOL: "Fetch historical OHLC candles for a symbol token.",
    GET_CONTROL_EVENTS_TOOL: "List recent control-plane live events.",
    GET_CONTROL_TRADES_TOOL: "List recent live trades.",
    GET_CONTROL_ORDERS_TOOL: "List recent live orders.",
    GET_EVENT_SESSIONS_TOOL: "List live event sessions.",
    GET_EVENT_SESSION_EVENTS_TOOL: "List events for one live session.",
    GET_RESEARCH_SESSIONS_TOOL: "List AI research sessions.",
    GET_RESEARCH_SESSION_TOOL: "Get one AI research session by id.",
    GET_RESEARCH_MESSAGES_TOOL: "List chat messages for an AI research session.",
    "stop_engine": "Stop a data-plane engine process.",
    "delete_engine": "Delete a data-plane engine record.",
    "register_engine": "Register a data-plane engine.",
    "update_engine": "Update a data-plane engine record.",
    "create_research_session": "Create an AI research session.",
    "update_research_session": "Update an AI research session.",
    "append_research_message": "Append a message to an AI research session.",
    "upsert_research_action": "Create or update an AI research action.",
    "delete_research_action": "Delete an AI research action.",
}
