"""Bridge Telegram inbound messages to the Cursor SDK (via the shared base bridge)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from api.cursor_sdk_bridge import (
    CURSOR_CONFIG_HINT,
    control_plane_mcp_servers,
    cursor_sdk_bridge,
    load_cursor_api_env,
)
from event.telegram_agent_prompt import TELEGRAM_SESSION_NAME, build_telegram_agent_prompt
from event.telegram_client import (
    delete_telegram_message,
    edit_telegram_message,
    send_telegram_html_reply,
    send_telegram_plain_message_with_id,
    send_telegram_plain_messages,
)
from event.telegram_commands import (
    InboundKind,
    help_text,
    is_new_message,
    is_stop_message,
    resolve_inbound_agent_request,
)
from event.telegram_config import TelegramConfig, load_telegram_config
from event.telegram_format import _escape_html, normalize_telegram_agent_reply
from event.telegram_inbound import inbound_text_message, register_inbound_handler

log = logging.getLogger("backtrading.telegram_cursor_agent")

_instance: "TelegramCursorAgent | None" = None


def _append_session_footer(html: str, session_id: str) -> str:
    safe_id = _escape_html(session_id)
    footer = f"\n\n<i>Session {safe_id} · /continue or /resume {safe_id}</i>"
    return f"{html.rstrip()}{footer}"


def _format_tool_progress_label(tool_name: str | None) -> str:
    base = (tool_name or "tool").split("/")[-1].strip() or "tool"
    normalized = base.lower().replace("-", "_")
    labels = {
        "websearch": "Web search",
        "web_search": "Web search",
        "webfetch": "Web fetch",
        "web_fetch": "Web fetch",
        "get_etoro_positions": "eToro positions",
        "get_portfolio": "Portfolio",
        "search_instruments": "Instrument search",
    }
    if normalized in labels:
        return labels[normalized]
    words = [word for word in base.replace("-", "_").split("_") if word]
    if not words:
        return "Working"
    return " ".join(word[:1].upper() + word[1:] for word in words)


class _RunProgress:
    def __init__(self, config: TelegramConfig, chat_id: str) -> None:
        self.config = config
        self.chat_id = chat_id
        self.message_id: int | None = None
        self.last_text: str | None = None

    def start(self) -> None:
        self.message_id = send_telegram_plain_message_with_id(
            self.config,
            self.chat_id,
            "Running agent…",
        )

    def update(self, detail: str | None = None) -> None:
        text = f"Running agent… ({detail})" if detail else "Running agent…"
        if text == self.last_text:
            return
        self.last_text = text
        if self.message_id is None:
            self.message_id = send_telegram_plain_message_with_id(self.config, self.chat_id, text)
            return
        if not edit_telegram_message(
            self.config,
            self.chat_id,
            self.message_id,
            text,
            plain=True,
        ):
            self.message_id = send_telegram_plain_message_with_id(self.config, self.chat_id, text)

    def finish(self) -> None:
        if self.message_id is None:
            return
        delete_telegram_message(self.config, self.chat_id, self.message_id)
        self.message_id = None

    def abandon(self, text: str) -> None:
        if self.message_id is None:
            return
        edit_telegram_message(
            self.config,
            self.chat_id,
            self.message_id,
            text,
            plain=True,
        )


class TelegramCursorAgent:
    """Run Cursor agent queries triggered by Telegram messages."""

    def __init__(self, config: TelegramConfig):
        self.config = config
        self._bridge = cursor_sdk_bridge
        self._last_session_ids: dict[str, str] = {}
        self._busy: set[str] = set()
        self._runs: dict[str, dict[str, Any]] = {}
        self._pending_stop: set[str] = set()
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

    async def _stop_run(self, chat_id: str) -> None:
        log.info("[TELEGRAM_AGENT] Stop requested chat_id=%s busy=%s", chat_id, chat_id in self._busy)

        if chat_id not in self._busy:
            send_telegram_plain_messages(self.config, chat_id, "No agent run in progress.")
            return

        state = self._runs.get(chat_id)
        if state is None:
            self._pending_stop.add(chat_id)
            send_telegram_plain_messages(self.config, chat_id, "Stopping agent…")
            return

        state["cancel_event"].set()
        run = state["active_run"].get("run")
        if run is not None and run.supports("cancel"):
            try:
                await run.cancel()
            except Exception as exc:
                log.warning("[TELEGRAM_AGENT] SDK cancel failed chat_id=%s: %s", chat_id, exc)

        task = state.get("task")
        if task is not None and not task.done():
            task.cancel()

        send_telegram_plain_messages(self.config, chat_id, "Agent stopped.")

    async def _create_new_session(self, chat_id: str) -> None:
        if chat_id in self._busy:
            send_telegram_plain_messages(
                self.config,
                chat_id,
                "Agent is already running for this chat. Send stop first.",
            )
            return

        load_cursor_api_env()
        if not self._bridge.configured:
            send_telegram_plain_messages(
                self.config,
                chat_id,
                f"Cursor agent is not configured. {CURSOR_CONFIG_HINT}",
            )
            return

        try:
            session_id = await self._bridge.open_session(
                session_name=TELEGRAM_SESSION_NAME,
                mcp_servers=control_plane_mcp_servers(),
            )
            self._last_session_ids[chat_id] = session_id
            log.info("[TELEGRAM_AGENT] New session chat_id=%s session=%s", chat_id, session_id)
            send_telegram_plain_messages(
                self.config,
                chat_id,
                f"New session created.\nSession: {session_id}",
            )
        except Exception as exc:
            log.exception("[TELEGRAM_AGENT] Failed to create session chat_id=%s", chat_id)
            send_telegram_plain_messages(self.config, chat_id, f"Error: {exc}")

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

        if is_stop_message(message["text"]):
            await self._stop_run(chat_id)
            return

        if is_new_message(message["text"]):
            await self._create_new_session(chat_id)
            return

        request = resolve_inbound_agent_request(message["text"])
        if request is None or request.kind == InboundKind.IGNORE:
            return

        if request.kind == InboundKind.NEW:
            await self._create_new_session(chat_id)
            return

        if chat_id in self._busy:
            send_telegram_plain_messages(
                self.config,
                chat_id,
                "Agent is already running for this chat. Send stop to cancel it.",
            )
            return

        if request.kind == InboundKind.HELP:
            send_telegram_plain_messages(
                self.config,
                chat_id,
                help_text(self._last_session_ids.get(chat_id)),
            )
            return

        if not request.question.strip():
            send_telegram_plain_messages(
                self.config,
                chat_id,
                help_text(self._last_session_ids.get(chat_id)),
            )
            return

        agent_id: str | None
        if request.new_session:
            agent_id = None
        elif request.agent_id:
            agent_id = request.agent_id
        elif request.use_last_session:
            agent_id = self._last_session_ids.get(chat_id)
            if not agent_id:
                send_telegram_plain_messages(
                    self.config,
                    chat_id,
                    "No saved session for this chat. Run a command first, or use /resume SESSION_ID.",
                )
                return
        else:
            agent_id = self._last_session_ids.get(chat_id)

        log.info(
            "[TELEGRAM_AGENT] Dispatching query chat_id=%s agent_id=%s new_session=%s resume=%s prompt_len=%d",
            chat_id,
            agent_id or "-",
            request.new_session,
            request.resume_with_summary,
            len(request.question),
        )
        cancel_event = asyncio.Event()
        active_run: dict[str, Any] = {"run": None}
        self._runs[chat_id] = {
            "cancel_event": cancel_event,
            "active_run": active_run,
            "task": None,
        }
        self._busy.add(chat_id)
        if chat_id in self._pending_stop:
            self._pending_stop.discard(chat_id)
            self._runs.pop(chat_id, None)
            self._busy.discard(chat_id)
            send_telegram_plain_messages(self.config, chat_id, "Agent stopped.")
            return

        task = asyncio.create_task(
            self._run_agent(
                chat_id,
                request.question,
                agent_id,
                cancel_event=cancel_event,
                active_run=active_run,
                resume_with_summary=request.resume_with_summary,
                new_session=request.new_session,
            ),
            name=f"TelegramCursorAgent-{chat_id}",
        )
        self._runs[chat_id]["task"] = task

    async def _run_agent(
        self,
        chat_id: str,
        user_question: str,
        agent_id: str | None,
        cancel_event: asyncio.Event,
        active_run: dict[str, Any],
        *,
        resume_with_summary: bool = False,
        new_session: bool = False,
    ) -> None:
        load_cursor_api_env()
        stopped = False
        progress: _RunProgress | None = None
        try:
            if chat_id in self._pending_stop:
                self._pending_stop.discard(chat_id)
                send_telegram_plain_messages(self.config, chat_id, "Agent stopped.")
                return

            if not self._bridge.configured:
                send_telegram_plain_messages(
                    self.config,
                    chat_id,
                    f"Cursor agent is not configured. {CURSOR_CONFIG_HINT}",
                )
                return

            progress = _RunProgress(self.config, chat_id)
            progress.start()
            final_text: str | None = None
            error: str | None = None
            new_agent_id = agent_id

            prompt = build_telegram_agent_prompt(
                user_question,
                new_session=agent_id is None,
                resume_with_summary=resume_with_summary,
            )
            log.info(
                "[TELEGRAM_AGENT] Prompt ready chat_id=%s agent_id=%s prompt_len=%d",
                chat_id,
                agent_id or "-",
                len(prompt),
            )
            announced_new_session = False
            async for event in self._bridge.stream_run(
                session_name=TELEGRAM_SESSION_NAME,
                prompt=prompt,
                agent_id=agent_id,
                mcp_servers=control_plane_mcp_servers(),
                cancel_event=cancel_event,
                active_run=active_run,
            ):
                event_type = event.get("type")
                if event_type == "start":
                    new_agent_id = event.get("agent_id") or new_agent_id
                    if new_agent_id:
                        self._last_session_ids[chat_id] = new_agent_id
                    if new_session and event.get("new_agent") and new_agent_id and not announced_new_session:
                        send_telegram_plain_messages(
                            self.config,
                            chat_id,
                            f"New session created.\nSession: {new_agent_id}",
                        )
                        announced_new_session = True
                elif event_type == "tool_call":
                    tool_status = str(event.get("tool_status") or "").lower()
                    if tool_status not in {"completed", "complete", "success", "succeeded", "done", "failed", "error"}:
                        progress.update(_format_tool_progress_label(event.get("tool_name")))
                elif event_type == "status":
                    status_msg = str(event.get("message") or "").strip()
                    if status_msg:
                        progress.update(status_msg[:80])
                elif event_type == "stopped":
                    stopped = True
                    break
                elif event_type == "error":
                    error = str(event.get("message") or "Agent error")
                    break
                elif event_type == "done":
                    final_text = str(event.get("text") or final_text or "")
                    new_agent_id = event.get("agent_id") or new_agent_id

            if stopped or cancel_event.is_set():
                progress.abandon("Agent stopped.")
                return
            if error:
                progress.abandon("Agent error.")
                send_telegram_plain_messages(self.config, chat_id, f"Error: {error}")
            elif final_text and final_text.strip():
                progress.finish()
                body = normalize_telegram_agent_reply(final_text)
                if new_agent_id:
                    body = _append_session_footer(body, new_agent_id)
                send_telegram_html_reply(self.config, chat_id, body)
            else:
                progress.finish()
                send_telegram_plain_messages(self.config, chat_id, "Agent finished with no text reply.")

            if new_agent_id:
                self._last_session_ids[chat_id] = new_agent_id
        except asyncio.CancelledError:
            log.info("[TELEGRAM_AGENT] Task cancelled chat_id=%s", chat_id)
            if progress is not None and not cancel_event.is_set():
                progress.abandon("Agent stopped.")
                send_telegram_plain_messages(self.config, chat_id, "Agent stopped.")
            raise
        except Exception as exc:
            log.exception("[TELEGRAM_AGENT] Run failed chat_id=%s", chat_id)
            if progress is not None:
                progress.abandon("Agent error.")
            if not cancel_event.is_set():
                send_telegram_plain_messages(self.config, chat_id, f"Error: {exc}")
        finally:
            self._runs.pop(chat_id, None)
            self._busy.discard(chat_id)
            self._pending_stop.discard(chat_id)


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
            "[TELEGRAM_AGENT] TELEGRAM_CURSOR_AGENT enabled but Cursor API is not configured; "
            "stop/help handlers active, agent runs disabled"
        )

    _instance = TelegramCursorAgent(config)
    return _instance


def stop_telegram_cursor_agent() -> None:
    global _instance
    _instance = None
