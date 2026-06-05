"""Async Cursor SDK agent bridge for strategy / market Q&A."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from api.ai_research_routes import (
    derive_research_summary,
    derive_session_title,
    extract_reply_summary,
    get_ai_research_store,
    merge_extracted_actions,
    strip_ai_action_blocks,
    strip_ai_summary_blocks,
)
from api.workspace_media import (
    attachments_from_paths,
    extract_media_attachments,
)
from api.control_plane_mcp_tools import (
    ASK_CONTROL_PLANE_READ_MCP_HINT,
    CONTROL_PLANE_HTTP_SHELL_RE,
    CONTROL_PLANE_MCP_SERVER,
    EXECUTE_CONTROL_PLANE_MCP_HINT,
    MCP_MUTATION_TOOL_NAMES,
    READ_MCP_TOOL_NAMES,
    is_read_mcp_tool_name,
)
from control_plane.execution_source_links import (
    apply_research_source_to_engine,
    extract_execution_id_from_tool_payload,
    tool_call_links_research_execution,
)

from api.cursor_sdk_bridge import (
    CURSOR_CONFIG_HINT,
    control_plane_mcp_servers,
    cursor_sdk_bridge,
    load_cursor_api_env,
)

log = logging.getLogger("backtrading.cursor_agent")

STRATEGY_AGENT_HINT = """You are the in-repo assistant for a backtrading / live-strategy platform.

Help the user with:
- Saved strategy executions and how they are deployed via the control plane
- Strategy configuration (entry trigger, take profit, stop loss, capital, partial stocks)
- Live price streams, data-plane engines, and broker integrations (Angel One, eToro)
- Stock / instrument context when it appears in this repository or control-plane data

Prefer answers grounded in this repo (`api/`, `frontend/`, `strategies/`, `control_plane/`, `brokers/`).
When proposing a tradable setup, include a fenced JSON block the UI can turn into actions:

```json
{"ai_action":{"type":"strategy_suggestion","title":"INFY breakout","payload":{"broker":"angel","symbol":"INFY-EQ","token":"1594","exchange":"NSE","close_price":1500,"long_percent":1,"short_percent":10,"initial_threshold":0.2,"max_available_capital":100000},"sources":["NSE prior close"]}}
```

If you need to inspect files or logs, use available tools. Be concise and practical."""

USER_FACING_RESPONSE_HINT = """User-facing reply rules (critical — applies to every assistant message shown in chat):

- Write for a trader, not an engineer. Focus on symbols, thesis, levels, sizing, risk, schedule intent, and broker account type (live vs demo) in plain language.
- Never expose platform or codebase internals in chat prose. Do not mention or explain: APScheduler, control plane, data plane, executor registration, engine registry, POST/GET routes, API payloads, MCP tools, uvicorn, repo paths, file names, UI component names, "UI action blocks", or how scheduled jobs work under the hood.
- Do not tell the user to manually POST payloads, register executors, or perform developer/debug steps. If they need to act, point them to product actions only: Save strategy, Schedule, Deploy live, or Stop — without describing what happens internally.
- You may use repo tools and control-plane actions silently when appropriate, but do not narrate that machinery in the reply unless the user explicitly asks for developer or architecture documentation.
- Keep `ai_action` JSON fences for strategy suggestions when needed; they are parsed by the UI and must not be preceded by technical explanations about how the UI consumes them.

When a reply benefits from a quick trader recap (research answers, stock analysis, strategy tradeoffs), end with a fenced JSON block the UI renders as Highlights / Lowlights / Cautions (omit the block for trivial one-line replies):

```json
{"ai_summary":{"highlights":["…"],"lowlights":["…"],"cautions":["…"]}}
```

Use 1–4 short bullets per section; leave a section empty only if truly not applicable. Do not duplicate the same bullet across sections."""

ASK_MODE_HINT = f"""You are in ASK mode (research / Q&A).

- Answer questions and explain tradeoffs; use repo and control-plane read tools when helpful.
{ASK_CONTROL_PLANE_READ_MCP_HINT}
- Prefer not to modify files or run destructive control-plane actions unless the user clearly asks.
- If they want strategies created, deployed, or code changed, you may do it when they ask — briefly confirm intent first."""

EXECUTE_MODE_HINT = f"""You are in EXECUTE mode.

You may inspect the repo, use tools, and interact with the control plane when the user asks (create/start/stop executions, apply code changes).

{EXECUTE_CONTROL_PLANE_MCP_HINT}

Prefer minimal, safe diffs and explain consequential actions before destructive control-plane operations."""

VALID_INTERACTION_MODES = frozenset({"ask", "execute"})

WEB_SEARCH_TOOL_NAMES = frozenset({
    "websearch",
    "webfetch",
    "web_search",
    "web_fetch",
})

ASK_READ_ONLY_TOOL_NAMES = frozenset({
    "read",
    "grep",
    "glob",
    "glob_file_search",
    "codebase_search",
    "semanticsearch",
    "list_dir",
    *WEB_SEARCH_TOOL_NAMES,
    "read_file",
    "readfile",
    "list_mcp_resources",
    "fetch_mcp_resource",
    *READ_MCP_TOOL_NAMES,
})

REPO_READ_TOOL_NAMES = frozenset(
    name
    for name in ASK_READ_ONLY_TOOL_NAMES
    if name not in WEB_SEARCH_TOOL_NAMES and name not in READ_MCP_TOOL_NAMES
)

WEB_SEARCH_ENABLED_HINT = """Web search toggle is ON (optional).

For live market news, prices, or recent events, websearch/webfetch are available. You may combine web search with repo and control-plane tools in the same turn when useful.
If you use the web for factual claims, end with a short **Sources** section (trader-facing site names / URLs). Do not name internal tools in the reply."""

WEB_SEARCH_DISABLED_HINT = """Web search toggle is OFF (optional).

Prefer repo and control-plane context first. Websearch/webfetch are still allowed if you need them — the toggle is a UI preference, not a hard block."""

ASK_BLOCKED_TOOL_NAMES = frozenset({
    "shell",
    "run_terminal_cmd",
    "terminal",
    "write",
    "search_replace",
    "strreplace",
    "edit",
    "delete",
    "apply_patch",
    "create",
    "execute",
    "task",
})

SHELL_TOOL_NAMES = frozenset({"shell", "run_terminal_cmd", "terminal"})

CONTROL_PLANE_MUTATION_RE = re.compile(
    r"|".join(
        [
            r"/api/control/executions",
            r"/api/control/engines",
            r"engine_process_manager",
            r"stop_all_controlled_executions",
            r"unschedule_all_controlled_executions",
            r"unschedule_controlled_execution",
            r"stop_controlled_execution",
            r"stop_engine",
            r"start_controlled_execution",
            r"create_controlled_execution",
            r"controlled_execution",
            r"control_plane\.db",
            r"engine_registry\.(upsert|update|delete)",
            r"make\s+(dev|cp)\b",
            r"uvicorn.*api\.(server|live_server)",
            r"executions/[^\s/]+/(start|stop|unschedule)",
            r"executions/(stop-all|bulk/unschedule)",
            r"deploy\s+live",
            r"stop\s+all\s+running",
        ]
    ),
    re.IGNORECASE,
)


class CursorAgentChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=20000)
    agent_id: Optional[str] = Field(default=None, max_length=256)


STRATEGY_AI_SESSION = "strategy_ai"


class CursorAgentService:
    """Strategy AI / research chat — web UI prompts on top of the shared SDK bridge."""

    def __init__(self) -> None:
        self._bridge = cursor_sdk_bridge

    @property
    def configured(self) -> bool:
        return self._bridge.configured

    def workspace(self) -> str:
        return self._bridge.workspace()

    def model(self) -> str:
        return self._bridge.model()

    async def startup(self) -> None:
        await self._bridge.startup()

    async def shutdown(self) -> None:
        await self._bridge.shutdown()

    async def health(self) -> dict[str, Any]:
        return await self._bridge.health()

    async def stream_chat(
        self,
        *,
        prompt: str,
        agent_id: Optional[str],
        interaction_mode: str = "ask",
        web_search_enabled: bool = True,
        research_session_id: Optional[str] = None,
        ws: WebSocket | None = None,
        cancel_event: asyncio.Event | None = None,
        active_run: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if not self.configured:
            yield {"type": "error", "phase": "config", "message": CURSOR_CONFIG_HINT}
            return

        user_prompt = prompt.strip()
        if not user_prompt:
            yield {"type": "error", "phase": "request", "message": "prompt is required"}
            return

        mode = interaction_mode if interaction_mode in VALID_INTERACTION_MODES else "ask"
        store = get_ai_research_store() if research_session_id else None

        if store and research_session_id:
            session = store.get_session(research_session_id)
            if not session:
                yield {
                    "type": "error",
                    "phase": "request",
                    "message": f"Research session not found: {research_session_id}",
                }
                return
            if agent_id is None and session.get("cursor_agent_id"):
                agent_id = session.get("cursor_agent_id")
            store.append_message(research_session_id, role="user", content=user_prompt)
            if session.get("title") in (None, "", "New research"):
                store.update_session(
                    research_session_id,
                    {"title": derive_session_title(user_prompt)},
                )
            if mode != session.get("interaction_mode"):
                store.update_session(research_session_id, {"interaction_mode": mode})
            session_metadata = dict(session.get("metadata") or {})
            if session_metadata.get("web_search_enabled") != web_search_enabled:
                session_metadata["web_search_enabled"] = web_search_enabled
                store.update_session(research_session_id, {"metadata": session_metadata})

        wrapped_prompt = _wrap_prompt(
            user_prompt,
            new_agent=not agent_id,
            interaction_mode=mode,
            web_search_enabled=web_search_enabled,
            research_session_id=research_session_id,
        )
        media_paths: list[str] = []

        async for event in self._bridge.stream_run(
            session_name=STRATEGY_AI_SESSION,
            prompt=wrapped_prompt,
            agent_id=agent_id,
            mcp_servers=control_plane_mcp_servers(),
            cancel_event=cancel_event,
            active_run=active_run,
        ):
            if ws is not None and ws.client_state.name != "CONNECTED":
                if cancel_event is not None:
                    cancel_event.set()
                return

            event_type = event.get("type")
            if event_type == "start":
                if store and research_session_id:
                    store.set_cursor_agent_id(research_session_id, event.get("agent_id"))
                yield {
                    **event,
                    "interaction_mode": mode,
                    "web_search_enabled": web_search_enabled,
                    "research_session_id": research_session_id,
                }
                continue

            if event_type == "text_delta":
                yield event
                continue

            if event_type == "media":
                for path in event.get("media_paths") or ():
                    if path not in media_paths:
                        media_paths.append(path)
                attachments = attachments_from_paths(event.get("media_paths") or ())
                if attachments:
                    yield {"type": "media", "attachments": attachments}
                continue

            if event_type == "tool_call":
                if store and research_session_id:
                    store.append_message(
                        research_session_id,
                        role="tool",
                        content=str(event.get("tool_name") or "tool"),
                        run_id=event.get("run_id"),
                        tool_name=event.get("tool_name"),
                        tool_status=event.get("tool_status"),
                        tool_detail=_tool_call_text(event),
                    )
                    _maybe_tag_research_execution_from_tool(research_session_id, event)
                blocked, reason = _tool_call_blocked(
                    event,
                    interaction_mode=mode,
                    web_search_enabled=web_search_enabled,
                )
                if blocked:
                    yield {
                        "type": "error",
                        "phase": "guardrail",
                        "agent_id": event.get("agent_id"),
                        "run_id": event.get("run_id"),
                        "message": reason,
                    }
                    return
                tool_attachments = extract_media_attachments(_tool_call_text(event))
                if tool_attachments:
                    for row in tool_attachments:
                        path = row.get("path")
                        if path and path not in media_paths:
                            media_paths.append(path)
                    yield {"type": "media", "attachments": tool_attachments}
                yield event
                continue

            if event_type == "done":
                final_text = str(event.get("text") or "")
                display_text = strip_ai_action_blocks(strip_ai_summary_blocks(final_text))
                reply_summary = extract_reply_summary(final_text)
                for path in extract_media_attachments(final_text):
                    rel = path.get("path")
                    if rel and rel not in media_paths:
                        media_paths.append(rel)
                final_attachments = attachments_from_paths(media_paths)
                if final_attachments:
                    yield {"type": "media", "attachments": final_attachments}
                assistant_message_id: str | None = None
                if store and research_session_id and final_text.strip():
                    metadata: dict[str, Any] | None = None
                    if final_attachments or reply_summary:
                        metadata = {}
                        if final_attachments:
                            metadata["attachments"] = final_attachments
                        if reply_summary:
                            metadata["reply_summary"] = reply_summary
                    saved = store.append_message(
                        research_session_id,
                        role="assistant",
                        content=display_text,
                        run_id=event.get("run_id"),
                        metadata=metadata,
                    )
                    assistant_message_id = saved.get("id") if saved else None
                    merge_extracted_actions(
                        research_session_id,
                        final_text,
                        message_id=assistant_message_id,
                    )
                    summary = derive_research_summary(final_text)
                    if summary:
                        store.update_session(research_session_id, {"summary": summary})
                yield {
                    **event,
                    "text": display_text,
                    "research_session_id": research_session_id,
                    "attachments": final_attachments,
                }
                continue

            yield event


cursor_agent_service = CursorAgentService()
router = APIRouter(prefix="/api/control/cursor-agent", tags=["cursor-agent"])


@router.get("/health")
async def cursor_agent_health():
    load_cursor_api_env()
    return {"status": True, "data": await cursor_agent_service.health()}


async def handle_cursor_agent_websocket(ws: WebSocket) -> None:
    load_cursor_api_env()
    await ws.accept()
    log.info("[CURSOR_AGENT_WS] Client connected")
    cancel_event = asyncio.Event()
    active_run: dict[str, Any] = {"run": None}
    chat_task: asyncio.Task | None = None

    async def run_chat(
        prompt: str,
        agent_id: Optional[str],
        interaction_mode: str,
        web_search_enabled: bool,
        research_session_id: Optional[str] = None,
    ) -> None:
        cancel_event.clear()
        try:
            async for event in cursor_agent_service.stream_chat(
                prompt=prompt,
                agent_id=agent_id,
                interaction_mode=interaction_mode,
                web_search_enabled=web_search_enabled,
                research_session_id=research_session_id,
                ws=ws,
                cancel_event=cancel_event,
                active_run=active_run,
            ):
                await ws.send_json(event)
        except asyncio.CancelledError:
            run = active_run.get("run")
            if run is not None and run.supports("cancel"):
                with contextlib.suppress(Exception):
                    await run.cancel()
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "stopped"})
            raise

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "phase": "request", "message": "Invalid JSON payload"})
                continue

            msg_type = msg.get("type")
            if msg_type == "ping":
                await ws.send_json({"type": "pong"})
                continue

            if msg_type == "health":
                await ws.send_json({"type": "health", "data": await cursor_agent_service.health()})
                continue

            if msg_type == "stop":
                log.info("[CURSOR_AGENT_WS] stop requested")
                cancel_event.set()
                run = active_run.get("run")
                if run is not None and run.supports("cancel"):
                    with contextlib.suppress(Exception):
                        await run.cancel()
                if chat_task is not None and not chat_task.done():
                    chat_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await chat_task
                else:
                    await ws.send_json({"type": "stopped"})
                cancel_event.clear()
                chat_task = None
                continue

            if msg_type != "chat":
                await ws.send_json({
                    "type": "error",
                    "phase": "request",
                    "message": f"Unsupported message type: {msg_type or 'missing'}",
                })
                continue

            prompt = str(msg.get("prompt") or "").strip()
            agent_id = msg.get("agent_id")
            if agent_id is not None:
                agent_id = str(agent_id).strip() or None

            if not prompt:
                await ws.send_json({"type": "error", "phase": "request", "message": "prompt is required"})
                continue

            interaction_mode = str(msg.get("interaction_mode") or msg.get("mode") or "ask").strip().lower()
            if interaction_mode not in VALID_INTERACTION_MODES:
                interaction_mode = "ask"

            research_session_id = msg.get("research_session_id")
            if research_session_id is not None:
                research_session_id = str(research_session_id).strip() or None

            web_search_enabled = msg.get("web_search_enabled", True)
            if isinstance(web_search_enabled, str):
                web_search_enabled = web_search_enabled.strip().lower() not in {"0", "false", "no", "off"}
            else:
                web_search_enabled = bool(web_search_enabled)

            if chat_task is not None and not chat_task.done():
                cancel_event.set()
                run = active_run.get("run")
                if run is not None and run.supports("cancel"):
                    with contextlib.suppress(Exception):
                        await run.cancel()
                chat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await chat_task
                cancel_event.clear()
                chat_task = None

            log.info(
                "[CURSOR_AGENT_WS] chat agent_id=%s session=%s mode=%s web_search=%s prompt_len=%d",
                agent_id or "-",
                research_session_id or "-",
                interaction_mode,
                web_search_enabled,
                len(prompt),
            )
            chat_task = asyncio.create_task(
                run_chat(prompt, agent_id, interaction_mode, web_search_enabled, research_session_id),
            )
    except WebSocketDisconnect:
        log.info("[CURSOR_AGENT_WS] Client disconnected")
        if chat_task is not None and not chat_task.done():
            cancel_event.set()
            chat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await chat_task
    except Exception as exc:
        log.exception("[CURSOR_AGENT_WS] Session error: %s", exc)
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "phase": "session", "message": str(exc)})


def _strict_ask_guardrails_enabled() -> bool:
    return os.getenv("CURSOR_AGENT_STRICT_ASK_GUARDRAILS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _wrap_prompt(
    user_prompt: str,
    *,
    new_agent: bool,
    interaction_mode: str = "ask",
    web_search_enabled: bool = True,
    research_session_id: Optional[str] = None,
) -> str:
    parts: list[str] = []
    if new_agent:
        parts.append(STRATEGY_AGENT_HINT)
    parts.append(WEB_SEARCH_ENABLED_HINT if web_search_enabled else WEB_SEARCH_DISABLED_HINT)
    if interaction_mode == "execute":
        parts.append(EXECUTE_MODE_HINT)
        if research_session_id:
            parts.append(
                f'Active AI Research session ({research_session_id}): '
                'every new execution MUST use source_id "ai_research" and '
                f'source_meta_id "{research_session_id}".'
            )
        else:
            parts.append(
                'Floating Strategy AI chat (no research session): '
                'use source_id "ai_chatbot_panel" and leave source_meta_id blank.'
            )
    else:
        parts.append(ASK_MODE_HINT)
    parts.append(USER_FACING_RESPONSE_HINT)
    if new_agent:
        parts.append(f"User question:\n{user_prompt}")
    else:
        parts.append(user_prompt)
    return "\n\n".join(parts)


def _maybe_tag_research_execution_from_tool(
    research_session_id: str,
    payload: dict[str, Any],
) -> None:
    tool_status = str(payload.get("tool_status") or "").lower()
    if tool_status not in {"completed", "complete", "success", "succeeded", "done"}:
        return
    if not tool_call_links_research_execution(payload):
        return

    execution_id = extract_execution_id_from_tool_payload(payload)
    if not execution_id:
        return

    try:
        from control_plane.engine_registry import EngineRegistry

        registry = EngineRegistry()
        engine = registry.get_engine(execution_id)
        apply_research_source_to_engine(registry, execution_id, research_session_id)
        if engine is None:
            engine = registry.get_engine(execution_id)
        store = get_ai_research_store()
        store.link_execution_to_session_actions(
            research_session_id,
            execution_id,
            engine,
        )
    except Exception as exc:
        log.warning(
            "[CURSOR_AGENT] Failed to link research execution %s: %s",
            execution_id,
            exc,
        )


def _tool_call_text(payload: dict[str, Any]) -> str:
    parts = [str(payload.get("tool_name") or "")]
    for key in ("args", "input", "arguments", "command", "parameters", "path", "content"):
        if payload.get(key):
            parts.append(str(payload[key]))
    return " ".join(parts)


def _normalize_tool_name(payload: dict[str, Any]) -> str:
    tool_name = str(payload.get("tool_name") or "").strip()
    return tool_name.lower().replace("-", "_").split(".")[-1]


def _tool_call_blocked(
    payload: dict[str, Any],
    *,
    interaction_mode: str,
    web_search_enabled: bool,
) -> tuple[bool, str]:
    normalized = _normalize_tool_name(payload)
    blob = _tool_call_text(payload)
    _ = web_search_enabled

    if (
        normalized in SHELL_TOOL_NAMES
        and CONTROL_PLANE_HTTP_SHELL_RE.search(blob)
    ):
        return (
            True,
            f"Use {CONTROL_PLANE_MCP_SERVER} MCP tools (e.g. create_strategy) instead of shell/curl for control-plane APIs.",
        )

    if not _strict_ask_guardrails_enabled():
        return False, ""

    if interaction_mode != "ask":
        return False, ""

    if normalized in MCP_MUTATION_TOOL_NAMES:
        return (
            True,
            "Ask mode is read-only. Switch to Execute to create, start, stop, or deploy strategies.",
        )

    if is_read_mcp_tool_name(normalized):
        return False, ""

    if normalized in ASK_READ_ONLY_TOOL_NAMES:
        return False, ""

    if CONTROL_PLANE_MUTATION_RE.search(blob):
        return (
            True,
            "Ask mode cannot create, start, stop, or deploy strategies via the control plane. Switch to Execute.",
        )

    if normalized in ASK_BLOCKED_TOOL_NAMES:
        return (
            True,
            "Ask mode is read-only. Switch to Execute to run shell commands or modify files.",
        )

    return (
        True,
        "Ask mode allows read-only repo tools only. Switch to Execute for this action.",
    )
