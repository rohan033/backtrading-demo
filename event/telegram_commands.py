"""Telegram bot commands mapped to Cursor agent prompts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

AGENT_PREFIX_RE = re.compile(r"^(?:/)?agent\s*:?\s*(.*)$", re.IGNORECASE | re.DOTALL)

BOT_COMMAND_RE = re.compile(
    r"^/(?P<name>[a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(?P<args>.*))?$",
    re.DOTALL,
)

CONTINUE_RE = re.compile(
    r"^/?continue(?:@[A-Za-z0-9_]+)?(?:\s+(?P<args>.*))?$",
    re.IGNORECASE | re.DOTALL,
)

RESUME_RE = re.compile(
    r"^/?resume(?:@[A-Za-z0-9_]+)?(?:\s+(?P<rest>.+))?$",
    re.IGNORECASE | re.DOTALL,
)


class InboundKind(str, Enum):
    IGNORE = "ignore"
    HELP = "help"
    NEW = "new"
    RUN = "run"


@dataclass(frozen=True)
class InboundAgentRequest:
    kind: InboundKind
    question: str = ""
    agent_id: str | None = None
    use_last_session: bool = False
    resume_with_summary: bool = False
    new_session: bool = False


DEFAULT_CONTINUE_QUESTION = (
    "Give a brief recap of where we left off, then suggest one sensible next step."
)

DEFAULT_RESUME_QUESTION = (
    "Give a brief recap of what this session has covered, then suggest one sensible next step."
)


@dataclass(frozen=True)
class TelegramBotCommand:
    name: str
    description: str
    question: str


TELEGRAM_BOT_COMMANDS: dict[str, TelegramBotCommand] = {
    "marketmood": TelegramBotCommand(
        name="marketmood",
        description="Today's market mood and bias",
        question="""Analyze today's overall market mood for intraday trading.

Cover major US indices, sector tone, risk-on vs risk-off bias, and whether conditions favor longs, shorts, or sitting out.
Use web search for today's news and price action.
Reply in Telegram HTML: headline plus sections (e.g. Indices, Sectors, Plan) with up to 4 bullets each.""",
    ),
    "suggest": TelegramBotCommand(
        name="suggest",
        description="Stocks to buy for intraday profits",
        question="""Suggest stocks to buy today for intraday profits.

Focus on liquid names with clear catalysts, volume, and defined entry, stop, and target levels for a same-day trade.
Use web search and broker/control-plane context when useful.
Reply in Telegram HTML: one section per stock (<b>TICKER</b>), max 4 bullets each (price, setup, levels, catalyst).""",
    ),
    "psuggest": TelegramBotCommand(
        name="psuggest",
        description="Penny stocks for greater intraday profits",
        question="""Suggest penny stocks (roughly under $5) for greater intraday profit potential today.

Highlight liquidity and volatility risks and tight risk management.
Use web search for today's movers and news.
Reply in Telegram HTML: one section per ticker, max 4 bullets each (price, setup, levels, risk note).""",
    ),
}

TELEGRAM_MENU_COMMANDS: tuple[tuple[str, str], ...] = (
    ("stop", "Cancel the agent run in progress"),
    ("new", "Start a new agent session"),
    ("continue", "Resume last session (recap first)"),
)

HELP_COMMANDS = frozenset({"help", "start"})

STOP_MESSAGE_RE = re.compile(r"^/?stop(?:@[A-Za-z0-9_]+)?\s*$", re.IGNORECASE)
NEW_MESSAGE_RE = re.compile(r"^/?new(?:@[A-Za-z0-9_]+)?\s*$", re.IGNORECASE)


def parse_bot_command(text: str) -> tuple[str, str] | None:
    """Return (command_name, args) for /command messages, else None."""
    match = BOT_COMMAND_RE.match(text.strip())
    if match is None:
        return None
    return match.group("name").lower(), (match.group("args") or "").strip()


def parse_continue_message(text: str) -> str | None:
    """Return follow-up args for continue, or '' when continue has no args; None if not continue."""
    match = CONTINUE_RE.match(text.strip())
    if match is None:
        return None
    return (match.group("args") or "").strip()


def parse_resume_message(text: str) -> tuple[str, str] | None:
    """Return (session_id, question) for resume commands."""
    match = RESUME_RE.match(text.strip())
    if match is None:
        return None
    rest = (match.group("rest") or "").strip()
    if not rest:
        return None
    parts = rest.split(None, 1)
    session_id = parts[0]
    question = parts[1].strip() if len(parts) > 1 else DEFAULT_RESUME_QUESTION
    return session_id, question


def command_question(name: str, args: str = "") -> str | None:
    """Build the agent user question for a registered bot command."""
    spec = TELEGRAM_BOT_COMMANDS.get(name)
    if spec is None:
        return None
    if args:
        return f"{spec.question.strip()}\n\nAdditional context from user: {args}"
    return spec.question.strip()


def bot_commands_for_api() -> list[dict[str, str]]:
    """Payload for Telegram setMyCommands."""
    commands = [
        {"command": spec.name, "description": spec.description[:256]}
        for spec in TELEGRAM_BOT_COMMANDS.values()
    ]
    commands.extend(
        {"command": name, "description": description[:256]}
        for name, description in TELEGRAM_MENU_COMMANDS
    )
    return commands


def help_text(last_session_id: str | None = None) -> str:
    lines = [
        "Trading bot commands:",
        "",
        "  /marketmood — today's market mood and bias",
        "  /suggest — stocks for intraday profits",
        "  /psuggest — penny stocks for intraday profits",
        "  /stop — cancel the agent run in progress",
        "  /new — start a new session (no query)",
        "",
        "Sessions:",
        "  /new — start a new session",
        "  /marketmood, /suggest, /psuggest — run using current session",
        "  /agent or agent … — continue the current session",
        "  /continue — reuse last session (recap first)",
        "  /resume SESSION_ID — reuse a specific session (recap first)",
        "",
        "Examples:",
        "  /suggest tech only",
        "  /continue what changed on NVDA?",
        "  /resume abc-123 summarize my positions",
    ]
    if last_session_id:
        lines.extend(["", f"Last session for this chat: {last_session_id}"])
    return "\n".join(lines)


def is_stop_message(text: str) -> bool:
    """True when the user wants to cancel the in-flight agent run."""
    return bool(STOP_MESSAGE_RE.match(text.strip()))


def is_new_message(text: str) -> bool:
    """True when the user wants a fresh agent session without running a query."""
    return bool(NEW_MESSAGE_RE.match(text.strip()))


def parse_agent_prompt(text: str) -> str | None:
    """Return prompt body when text is an agent command, else None."""
    match = AGENT_PREFIX_RE.match(text.strip())
    if match is None:
        return None
    return match.group(1).strip()


def resolve_inbound_agent_request(text: str) -> InboundAgentRequest | None:
    """Map inbound Telegram text to an agent run request."""
    stripped = text.strip()
    if not stripped:
        return None

    if is_stop_message(stripped):
        return None

    if is_new_message(stripped):
        return InboundAgentRequest(kind=InboundKind.NEW)

    continue_args = parse_continue_message(stripped)
    if continue_args is not None:
        question = continue_args or DEFAULT_CONTINUE_QUESTION
        return InboundAgentRequest(
            kind=InboundKind.RUN,
            question=question,
            use_last_session=True,
            resume_with_summary=True,
        )

    resume = parse_resume_message(stripped)
    if resume is not None:
        session_id, question = resume
        return InboundAgentRequest(
            kind=InboundKind.RUN,
            question=question,
            agent_id=session_id,
            resume_with_summary=True,
        )

    bot = parse_bot_command(stripped)
    if bot is not None:
        name, args = bot
        if name in HELP_COMMANDS:
            return InboundAgentRequest(kind=InboundKind.HELP)
        if name == "continue":
            question = args or DEFAULT_CONTINUE_QUESTION
            return InboundAgentRequest(
                kind=InboundKind.RUN,
                question=question,
                use_last_session=True,
                resume_with_summary=True,
            )
        if name == "new":
            return InboundAgentRequest(kind=InboundKind.NEW)
        if name == "resume":
            if not args:
                return InboundAgentRequest(kind=InboundKind.HELP)
            parsed = parse_resume_message(stripped)
            if parsed is None:
                return InboundAgentRequest(kind=InboundKind.HELP)
            session_id, question = parsed
            return InboundAgentRequest(
                kind=InboundKind.RUN,
                question=question,
                agent_id=session_id,
                resume_with_summary=True,
            )
        if name == "agent":
            return InboundAgentRequest(kind=InboundKind.RUN, question=args)
        question = command_question(name, args)
        if question is not None:
            return InboundAgentRequest(kind=InboundKind.RUN, question=question)
        return InboundAgentRequest(kind=InboundKind.IGNORE)

    agent_prompt = parse_agent_prompt(stripped)
    if agent_prompt is not None:
        return InboundAgentRequest(kind=InboundKind.RUN, question=agent_prompt)

    if stripped.lower() in {"hi", "hello", "hey", "help"}:
        return InboundAgentRequest(kind=InboundKind.HELP)

    return InboundAgentRequest(kind=InboundKind.IGNORE)


def resolve_inbound_agent_prompt(text: str) -> tuple[str | None, bool]:
    """Legacy helper: (question, fresh_session). Prefer resolve_inbound_agent_request."""
    req = resolve_inbound_agent_request(text)
    if req is None or req.kind == InboundKind.IGNORE:
        return None, True
    if req.kind == InboundKind.HELP:
        return "", False
    fresh = req.new_session
    return req.question, fresh
