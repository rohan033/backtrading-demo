"""Bridge Telegram inbound messages to the Cursor SDK (via the shared base bridge)."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from api.cursor_sdk_bridge import (
    CURSOR_CONFIG_HINT,
    control_plane_mcp_servers,
    cursor_sdk_bridge,
    load_cursor_api_env,
)
from event.telegram_agent_prompt import TELEGRAM_SESSION_NAME, build_telegram_agent_prompt
from event.telegram_client import send_telegram_html_reply, send_telegram_messages
from event.telegram_config import TelegramConfig, load_telegram_config
from event.telegram_format import normalize_telegram_agent_reply
from event.telegram_inbound import inbound_text_message, register_inbound_handler

log = logging.getLogger("backtrading.telegram_cursor_agent")

AGENT_PREFIX_RE = re.compile(r"^(?:/)?agent\s*:?\s*(.*)$", re.IGNORECASE | re.DOTALL)

HELP_TEXT = (
    "Send a message starting with agent followed by your question.\n\n"
    "Examples:\n"
    "  agent what is BBAI doing?\n"
    "  agent create a demo strategy for IONQ\n\n"
    "Replies continue the same Cursor session for this chat."
)

_instance: "TelegramCursorAgent | None" = None


def parse_agent_prompt(text: str) -> str | None:
    """Return prompt body when text is an agent command, else None."""
    match = AGENT_PREFIX_RE.match(text.strip())
    if match is None:
        return None
    return match.group(1).strip()


class TelegramCursorAgent:
    """Run Cursor agent queries triggered by Telegram messages."""

    def __init__(self, config: TelegramConfig):
        self.config = config
        self._bridge = cursor_sdk_bridge
        self._agent_ids: dict[str, str] = {}
        self._busy: set[str] = set()
        self._allowed_chat_ids = self._load_allowed_chat_ids()
        register_inbound_handler(self._on_update)
        log.info(
            "[TELEGRAM_AGENT] Cursor agent bridge ready allowed_chats=%s",
            sorted(self._allowed_chat_ids),
        )

    def _load_allowed_chat_ids(self) -> set[str]:
        import os

        allowed = {str(self.config.chat_id)}
        raw = os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").strip()
        if raw:
            allowed.update(part.strip() for part in raw.split(",") if part.strip())
        return allowed

    def _chat_allowed(self, chat_id: str) -> bool:
        return chat_id in self._allowed_chat_ids

    async def _on_update(self, update: dict[str, Any]) -> None:
        if update.get("edited_message"):
            return

        message = inbound_text_message(update)
        if message is None:
            return

        chat_id = str(message["chat_id"])
        if not self._chat_allowed(chat_id):
            log.info("[TELEGRAM_AGENT] Ignoring message from unauthorized chat_id=%s", chat_id)
            return

        prompt = parse_agent_prompt(message["text"])
        if prompt is None:
            text_lower = message["text"].strip().lower()
            if text_lower in {"hi", "hello", "hey", "help", "/start", "/help"}:
                send_telegram_messages(self.config, chat_id, HELP_TEXT)
            return

        if chat_id in self._busy:
            send_telegram_messages(
                self.config,
                chat_id,
                "Agent is already running for this chat. Please wait for the current reply.",
            )
            return

        if not prompt:
            send_telegram_messages(self.config, chat_id, HELP_TEXT)
            return

        log.info("[TELEGRAM_AGENT] Dispatching agent query chat_id=%s prompt_len=%d", chat_id, len(prompt))
        self._busy.add(chat_id)
        asyncio.create_task(
            self._run_agent(chat_id, prompt, self._agent_ids.get(chat_id)),
            name=f"TelegramCursorAgent-{chat_id}",
        )

    async def _run_agent(self, chat_id: str, user_question: str, agent_id: str | None) -> None:
        load_cursor_api_env()
        try:
            if not self._bridge.configured:
                send_telegram_messages(
                    self.config,
                    chat_id,
                    f"Cursor agent is not configured. {CURSOR_CONFIG_HINT}",
                )
                return

            send_telegram_messages(self.config, chat_id, "Running agent…")
            final_text: str | None = None
            error: str | None = None
            new_agent_id = agent_id

            prompt = build_telegram_agent_prompt(user_question, new_session=agent_id is None)
            async for event in self._bridge.stream_run(
                session_name=TELEGRAM_SESSION_NAME,
                prompt=prompt,
                agent_id=agent_id,
                mcp_servers=control_plane_mcp_servers(),
            ):
                event_type = event.get("type")
                if event_type == "start":
                    new_agent_id = event.get("agent_id") or new_agent_id
                elif event_type == "error":
                    error = str(event.get("message") or "Agent error")
                    break
                elif event_type == "done":
                    final_text = str(event.get("text") or final_text or "")
                    new_agent_id = event.get("agent_id") or new_agent_id

            if error:
                send_telegram_messages(self.config, chat_id, f"Error: {error}")
            elif final_text and final_text.strip():
                send_telegram_html_reply(
                    self.config,
                    chat_id,
                    normalize_telegram_agent_reply(final_text),
                )
            else:
                send_telegram_messages(self.config, chat_id, "Agent finished with no text reply.")

            if new_agent_id:
                self._agent_ids[chat_id] = new_agent_id
        except asyncio.CancelledError:
            send_telegram_messages(self.config, chat_id, "Agent run cancelled.")
            raise
        except Exception as exc:
            log.exception("[TELEGRAM_AGENT] Run failed chat_id=%s", chat_id)
            send_telegram_messages(self.config, chat_id, f"Error: {exc}")
        finally:
            self._busy.discard(chat_id)


def maybe_start_telegram_cursor_agent() -> TelegramCursorAgent | None:
    global _instance
    if _instance is not None:
        return _instance

    config = load_telegram_config()
    if config is None or not config.enabled or not config.cursor_agent:
        return None

    load_cursor_api_env()
    if not cursor_sdk_bridge.configured:
        log.warning(
            "[TELEGRAM_AGENT] TELEGRAM_CURSOR_AGENT enabled but Cursor API is not configured"
        )
        return None

    _instance = TelegramCursorAgent(config)
    return _instance


def stop_telegram_cursor_agent() -> None:
    global _instance
    _instance = None
