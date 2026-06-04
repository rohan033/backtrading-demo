"""Telegram-specific Cursor agent prompt assembly (independent of Strategy AI)."""

from __future__ import annotations

from api.control_plane_mcp_tools import EXECUTE_CONTROL_PLANE_MCP_HINT
from event.telegram_format import telegram_channel_skill_instructions

TELEGRAM_SESSION_NAME = "telegram"

TELEGRAM_AGENT_SCOPE = """You are the trading assistant for this backtrading platform, replying over Telegram.

You may inspect the repo and use control-plane MCP tools to answer questions, read positions, and manage strategies when the user asks.

Use tools silently — never describe internal APIs, routes, or code paths in the reply.

{execute_hint}""".format(execute_hint=EXECUTE_CONTROL_PLANE_MCP_HINT)


TELEGRAM_WEB_SEARCH_HINT = """Web search is always enabled for Telegram.

For live market news, prices, or recent events, use websearch/webfetch. You may combine web search with repo and control-plane tools in the same turn when useful.
If you use the web for factual claims, add a brief sources line in the HTML reply (trader-facing site names or URLs). Do not name internal tools in the reply."""

TELEGRAM_SESSION_RESUME_HINT = """Resuming an existing Cursor agent session on Telegram.

Structure one HTML reply in two parts:
1) <b>Session recap</b> — short sections (max 4 bullets each) covering what this session already discussed or decided
2) Then answer the user's request below

Keep the recap compact; most of the reply should address the new request."""


TELEGRAM_CONTINUING_HINT = """Continue this Telegram session. Reply in HTML using the telegram-channel-html section layout (headline + <b>sections</b> with up to 4 • bullets each). Use web search when you need live prices or news."""


def build_telegram_agent_prompt(
    user_question: str,
    *,
    new_session: bool,
    resume_with_summary: bool = False,
) -> str:
    """Build the full Cursor SDK prompt for a Telegram agent turn."""
    parts: list[str] = []
    if new_session:
        parts.append(TELEGRAM_AGENT_SCOPE)
        parts.append(TELEGRAM_WEB_SEARCH_HINT)
        parts.append(telegram_channel_skill_instructions())
    elif resume_with_summary:
        parts.append(TELEGRAM_WEB_SEARCH_HINT)
        parts.append(telegram_channel_skill_instructions())
        parts.append(TELEGRAM_SESSION_RESUME_HINT)
    else:
        parts.append(TELEGRAM_CONTINUING_HINT)
    parts.append(f"User question:\n{user_question.strip()}")
    return "\n\n".join(parts)
