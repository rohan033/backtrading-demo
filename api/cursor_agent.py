"""Async Cursor SDK agent bridge for strategy / market Q&A."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from collections import OrderedDict
from typing import Any, AsyncIterator, Optional

from cursor_sdk import AsyncClient, CursorAgentError, LocalAgentOptions
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from api.ai_research_routes import (
    derive_research_summary,
    derive_session_title,
    get_ai_research_store,
    merge_extracted_actions,
    strip_ai_action_blocks,
)
from control_plane.engine_process_manager import REPO_ROOT
from control_plane.execution_source_links import (
    apply_research_source_to_engine,
    extract_execution_id_from_tool_payload,
    tool_call_created_execution,
)

log = logging.getLogger("backtrading.cursor_agent")

CURSOR_API_KEY_ENV = "CURSOR_API_KEY"
CURSOR_API_ENV_FILE = ".cursor-api.env"
CURSOR_AGENT_MODEL_ENV = "CURSOR_AGENT_MODEL"
CURSOR_AGENT_WORKSPACE_ENV = "CURSOR_AGENT_WORKSPACE"
CURSOR_AGENT_MAX_SESSIONS_ENV = "CURSOR_AGENT_MAX_SESSIONS"

DEFAULT_MODEL = "composer-2.5"
MAX_AGENT_SESSIONS = 32
CURSOR_CONFIG_HINT = f"Set {CURSOR_API_KEY_ENV} in {CURSOR_API_ENV_FILE} and restart the control plane."


def load_cursor_api_env() -> bool:
    """Load gitignored Cursor credentials from repo root."""
    from dotenv import load_dotenv

    path = REPO_ROOT / CURSOR_API_ENV_FILE
    if not path.is_file():
        return False
    load_dotenv(path, override=True)
    return bool(os.getenv(CURSOR_API_KEY_ENV, "").strip())

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
- Keep `ai_action` JSON fences for strategy suggestions when needed; they are parsed by the UI and must not be preceded by technical explanations about how the UI consumes them."""

ASK_MODE_HINT = """You are in ASK mode (read-only guardrails).

- Answer questions and explain tradeoffs using the codebase and read-only context.
- You may use read-only repo tools (search/read files) when needed to ground answers.
- Do NOT modify files, run shell commands, or use write/edit/terminal tools.
- Do NOT interact with the control plane or live trading runtime in any way, including:
  - Creating, deploying, starting, duplicating, or stopping strategy executions
  - Calling `/api/control/executions`, `/api/control/engines`, or related POST/DELETE routes
  - Running `make dev`, `make cp`, `uvicorn`, or scripts that spawn/stop data-plane engines
  - Writing to `control_plane.db` or mutating engine registry state
- If the user wants strategies created/stopped or code changed, explain the steps and tell them to switch to Execute mode."""

EXECUTE_MODE_HINT = """You are in EXECUTE mode.

You may inspect the repo, use tools, and interact with the control plane when the user asks (create/start/stop executions, apply code changes). Prefer minimal, safe diffs and explain consequential actions before destructive control-plane operations.

When creating strategy executions via POST /api/control/executions, always include source_id in the JSON body:
- "ai_chatbot_panel" when creating from the floating Strategy AI panel (leave source_meta_id blank)
- "ai_research" when the prompt indicates an active AI Research session — you MUST set source_meta_id to that session id
- "user" for manual/user flows (leave source_meta_id blank)"""

VALID_INTERACTION_MODES = frozenset({"ask", "execute"})
CONTROL_PLANE_MCP_SERVER = "backtrading-control-plane"

ASK_READ_ONLY_TOOL_NAMES = frozenset({
    "read",
    "grep",
    "glob",
    "glob_file_search",
    "codebase_search",
    "semanticsearch",
    "list_dir",
    "websearch",
    "webfetch",
    "read_file",
    "readfile",
    "list_mcp_resources",
    "fetch_mcp_resource",
})

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

CONTROL_PLANE_MUTATION_RE = re.compile(
    r"|".join(
        [
            r"/api/control/executions",
            r"/api/control/engines",
            r"engine_process_manager",
            r"stop_all_controlled_executions",
            r"stop_controlled_execution",
            r"stop_engine",
            r"start_controlled_execution",
            r"create_controlled_execution",
            r"controlled_execution",
            r"control_plane\.db",
            r"engine_registry\.(upsert|update|delete)",
            r"make\s+(dev|cp)\b",
            r"uvicorn.*api\.(server|live_server)",
            r"executions/[^\s/]+/(start|stop)",
            r"executions/stop-all",
            r"deploy\s+live",
            r"stop\s+all\s+running",
        ]
    ),
    re.IGNORECASE,
)


class CursorAgentChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=20000)
    agent_id: Optional[str] = Field(default=None, max_length=256)


class CursorAgentService:
    def __init__(self) -> None:
        self._client: AsyncClient | None = None
        self._client_lock = asyncio.Lock()
        self._agents: OrderedDict[str, Any] = OrderedDict()
        self._agents_lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(os.getenv(CURSOR_API_KEY_ENV, "").strip())

    def workspace(self) -> str:
        configured = os.getenv(CURSOR_AGENT_WORKSPACE_ENV, "").strip()
        return configured or str(REPO_ROOT)

    def model(self) -> str:
        return os.getenv(CURSOR_AGENT_MODEL_ENV, DEFAULT_MODEL).strip() or DEFAULT_MODEL

    def max_sessions(self) -> int:
        raw = os.getenv(CURSOR_AGENT_MAX_SESSIONS_ENV, str(MAX_AGENT_SESSIONS)).strip()
        try:
            return max(1, int(raw))
        except ValueError:
            return MAX_AGENT_SESSIONS

    async def startup(self) -> None:
        load_cursor_api_env()
        if not self.configured:
            log.warning(
                "[CURSOR_AGENT] %s is not set; add it to %s to enable Strategy AI",
                CURSOR_API_KEY_ENV,
                CURSOR_API_ENV_FILE,
            )
            return

        async with self._client_lock:
            if self._client is not None:
                return
            workspace = self.workspace()
            log.info("[CURSOR_AGENT] Launching SDK bridge workspace=%s model=%s", workspace, self.model())
            self._client = await AsyncClient.launch_bridge(workspace=workspace)

    async def shutdown(self) -> None:
        async with self._agents_lock:
            agent_ids = list(self._agents.keys())
            self._agents.clear()

        for agent_id in agent_ids:
            await self._close_agent(agent_id, reason="shutdown")

        async with self._client_lock:
            client = self._client
            self._client = None
            if client is not None:
                await client.aclose()
                log.info("[CURSOR_AGENT] SDK bridge closed")

    async def health(self) -> dict[str, Any]:
        if not self.configured:
            return {
                "configured": False,
                "ready": False,
                "api_key_env": CURSOR_API_KEY_ENV,
                "message": CURSOR_CONFIG_HINT,
            }

        client = await self._require_client()
        try:
            ping = await client.ping()
            version = await client.get_version()
        except Exception as exc:
            log.warning("[CURSOR_AGENT] Health check failed: %s", exc)
            return {
                "configured": True,
                "ready": False,
                "api_key_env": CURSOR_API_KEY_ENV,
                "workspace": self.workspace(),
                "model": self.model(),
                "message": str(exc),
            }

        return {
            "configured": True,
            "ready": True,
            "api_key_env": CURSOR_API_KEY_ENV,
            "workspace": self.workspace(),
            "model": self.model(),
            "ping": ping,
            "version": version,
            "active_sessions": len(self._agents),
        }

    async def stream_chat(
        self,
        *,
        prompt: str,
        agent_id: Optional[str],
        interaction_mode: str = "ask",
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
        sdk_mode = "agent" if mode == "execute" else "ask"
        store = get_ai_research_store() if research_session_id else None
        user_message_id: str | None = None

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
            saved = store.append_message(
                research_session_id,
                role="user",
                content=user_prompt,
            )
            user_message_id = saved.get("id") if saved else None
            if session.get("title") in (None, "", "New research"):
                store.update_session(
                    research_session_id,
                    {"title": derive_session_title(user_prompt)},
                )
            if mode != session.get("interaction_mode"):
                store.update_session(research_session_id, {"interaction_mode": mode})

        client = await self._require_client()
        created_new_agent = not agent_id

        try:
            agent = await self._get_or_create_agent(client, agent_id, interaction_mode=mode)
        except CursorAgentError as exc:
            log.error("[CURSOR_AGENT] Agent startup failed: %s", exc)
            yield {
                "type": "error",
                "phase": "startup",
                "message": exc.message,
                "retryable": exc.is_retryable,
            }
            return
        except Exception as exc:
            log.exception("[CURSOR_AGENT] Unexpected agent startup failure")
            yield {"type": "error", "phase": "startup", "message": str(exc)}
            return

        message = _wrap_prompt(
            user_prompt,
            new_agent=created_new_agent,
            interaction_mode=mode,
            research_session_id=research_session_id,
        )
        run = None

        try:
            from cursor_sdk import SendOptions

            send_options = SendOptions(mode=sdk_mode)
            mcp_servers = _control_plane_mcp_servers(mode)
            if mcp_servers is not None:
                send_options = SendOptions(mode=sdk_mode, mcp_servers=mcp_servers)
            try:
                run = await agent.send(message, send_options)
            except Exception as exc:
                if sdk_mode != "ask":
                    raise
                log.warning("[CURSOR_AGENT] ask mode rejected by SDK, using prompt guardrails only: %s", exc)
                run = await agent.send(message)
            if active_run is not None:
                active_run["run"] = run
            yield {
                "type": "start",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "model": self.model(),
                "interaction_mode": mode,
                "research_session_id": research_session_id,
            }
            if store and research_session_id:
                store.set_cursor_agent_id(research_session_id, agent.agent_id)

            assistant_chunks: list[str] = []

            async for message_event in run.stream():
                if cancel_event is not None and cancel_event.is_set():
                    if run.supports("cancel"):
                        await run.cancel()
                    yield {
                        "type": "stopped",
                        "agent_id": agent.agent_id,
                        "run_id": run.id,
                    }
                    return

                if ws is not None and ws.client_state.name != "CONNECTED":
                    if run.supports("cancel"):
                        await run.cancel()
                    return

                payload = _sdk_message_payload(message_event)
                if not payload:
                    continue

                message_type = payload.get("message_type")
                if message_type == "assistant" and payload.get("text"):
                    assistant_chunks.append(payload["text"])
                    yield {"type": "text_delta", "text": payload["text"]}
                elif message_type == "tool_call":
                    if store and research_session_id:
                        store.append_message(
                            research_session_id,
                            role="tool",
                            content=str(payload.get("tool_name") or "tool"),
                            run_id=run.id,
                            tool_name=payload.get("tool_name"),
                            tool_status=payload.get("tool_status"),
                            tool_detail=_tool_call_text(payload),
                        )
                        _maybe_tag_research_execution_from_tool(research_session_id, payload)
                    if mode == "ask":
                        blocked, reason = _ask_mode_tool_blocked(payload)
                        if blocked:
                            if run.supports("cancel"):
                                await run.cancel()
                            yield {
                                "type": "error",
                                "phase": "guardrail",
                                "agent_id": agent.agent_id,
                                "run_id": run.id,
                                "message": reason,
                            }
                            return
                    yield {"type": "tool_call", **payload}
                elif message_type == "status":
                    yield {"type": "status", **payload}
                else:
                    yield {"type": "message", **payload}

            result = await run.wait()
            if result.status == "error":
                yield {
                    "type": "error",
                    "phase": "run",
                    "agent_id": agent.agent_id,
                    "run_id": run.id,
                    "status": result.status,
                    "message": "Cursor agent run failed",
                }
                return

            final_text = result.result or await run.text() or "".join(assistant_chunks)
            display_text = strip_ai_action_blocks(final_text)
            assistant_message_id: str | None = None
            if store and research_session_id and final_text.strip():
                saved = store.append_message(
                    research_session_id,
                    role="assistant",
                    content=display_text,
                    run_id=run.id,
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
                "type": "done",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "status": result.status,
                "text": display_text,
                "research_session_id": research_session_id,
            }
        except CursorAgentError as exc:
            log.error("[CURSOR_AGENT] Run startup failed agent=%s: %s", agent.agent_id, exc)
            yield {
                "type": "error",
                "phase": "startup",
                "agent_id": agent.agent_id,
                "run_id": getattr(run, "id", None),
                "message": exc.message,
                "retryable": exc.is_retryable,
            }
        except asyncio.CancelledError:
            if run is not None and run.supports("cancel"):
                with contextlib.suppress(Exception):
                    await run.cancel()
            raise
        except Exception as exc:
            log.exception("[CURSOR_AGENT] Streaming failure agent=%s", agent.agent_id)
            yield {
                "type": "error",
                "phase": "stream",
                "agent_id": agent.agent_id,
                "run_id": getattr(run, "id", None),
                "message": str(exc),
            }
        finally:
            if active_run is not None:
                active_run["run"] = None

    async def _require_client(self) -> AsyncClient:
        if self._client is None:
            await self.startup()
        if self._client is None:
            raise RuntimeError(f"{CURSOR_API_KEY_ENV} is not configured")
        return self._client

    async def _get_or_create_agent(
        self,
        client: AsyncClient,
        agent_id: Optional[str],
        *,
        interaction_mode: str = "ask",
    ):
        from cursor_sdk import AgentOptions

        api_key = os.environ[CURSOR_API_KEY_ENV].strip()
        sdk_mode = "agent" if interaction_mode == "execute" else "ask"
        mcp_servers = _control_plane_mcp_servers(interaction_mode)
        options = AgentOptions(
            api_key=api_key,
            model=self.model(),
            local=LocalAgentOptions(cwd=self.workspace()),
            mode=sdk_mode,
            mcp_servers=mcp_servers,
        )

        if agent_id:
            cached = self._agents.get(agent_id)
            if cached is not None:
                self._agents.move_to_end(agent_id)
                return cached

            agent = await client.agents.resume(agent_id, options)
            await self._remember_agent(agent)
            return agent

        agent = await client.agents.create(options)
        await self._remember_agent(agent)
        return agent

    async def _remember_agent(self, agent) -> None:
        async with self._agents_lock:
            self._agents[agent.agent_id] = agent
            self._agents.move_to_end(agent.agent_id)
            while len(self._agents) > self.max_sessions():
                old_id, old_agent = self._agents.popitem(last=False)
                await self._close_agent_instance(old_agent, old_id, reason="evicted")

    async def _close_agent(self, agent_id: str, *, reason: str) -> None:
        async with self._agents_lock:
            agent = self._agents.pop(agent_id, None)
        if agent is not None:
            await self._close_agent_instance(agent, agent_id, reason=reason)

    async def _close_agent_instance(self, agent, agent_id: str, *, reason: str) -> None:
        try:
            await agent.close()
        except Exception as exc:
            log.warning("[CURSOR_AGENT] Failed to close agent=%s (%s): %s", agent_id, reason, exc)


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
        research_session_id: Optional[str] = None,
    ) -> None:
        cancel_event.clear()
        try:
            async for event in cursor_agent_service.stream_chat(
                prompt=prompt,
                agent_id=agent_id,
                interaction_mode=interaction_mode,
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
                "[CURSOR_AGENT_WS] chat agent_id=%s session=%s mode=%s prompt_len=%d",
                agent_id or "-",
                research_session_id or "-",
                interaction_mode,
                len(prompt),
            )
            chat_task = asyncio.create_task(
                run_chat(prompt, agent_id, interaction_mode, research_session_id),
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


def _wrap_prompt(
    user_prompt: str,
    *,
    new_agent: bool,
    interaction_mode: str = "ask",
    research_session_id: Optional[str] = None,
) -> str:
    parts: list[str] = []
    if new_agent:
        parts.append(STRATEGY_AGENT_HINT)
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
    if not tool_call_created_execution(payload):
        return

    execution_id = extract_execution_id_from_tool_payload(payload)
    if not execution_id:
        return

    try:
        from control_plane.engine_registry import EngineRegistry

        registry = EngineRegistry()
        apply_research_source_to_engine(registry, execution_id, research_session_id)
    except Exception as exc:
        log.warning(
            "[CURSOR_AGENT] Failed to tag research source on %s: %s",
            execution_id,
            exc,
        )


def _control_plane_mcp_servers(interaction_mode: str) -> dict[str, Any] | None:
    """Attach control-plane MCP tools only in Execute mode."""
    if interaction_mode != "execute":
        return None

    from cursor_sdk import HttpMcpServerConfig

    from api.control_plane_mcp import CONTROL_PLANE_MCP_PATH

    control_plane_url = os.getenv("CONTROL_PLANE_URL", "http://127.0.0.1:8000").strip().rstrip("/")
    return {
        CONTROL_PLANE_MCP_SERVER: HttpMcpServerConfig(
            url=f"{control_plane_url}{CONTROL_PLANE_MCP_PATH}",
        )
    }


def _sdk_message_payload(message: Any) -> dict[str, Any] | None:
    message_type = getattr(message, "type", None)
    if not message_type:
        return None

    payload: dict[str, Any] = {"message_type": message_type}
    if message_type == "assistant":
        blocks = getattr(getattr(message, "message", None), "content", ()) or ()
        payload["text"] = "".join(getattr(block, "text", "") for block in blocks)
    elif message_type == "tool_call":
        payload["tool_name"] = getattr(message, "name", None)
        payload["tool_status"] = getattr(message, "status", None)
        _enrich_tool_payload(message, payload)
    elif message_type == "status":
        payload["status"] = getattr(message, "status", None)
        payload["message"] = getattr(message, "message", None)
    return payload


def _enrich_tool_payload(message: Any, payload: dict[str, Any]) -> None:
    for attr in ("args", "input", "arguments", "command", "parameters", "path", "content"):
        if not hasattr(message, attr):
            continue
        value = getattr(message, attr)
        if value is None:
            continue
        if isinstance(value, str):
            payload[attr] = value
        else:
            with contextlib.suppress(TypeError, ValueError):
                payload[attr] = json.dumps(value)
            if attr not in payload:
                payload[attr] = str(value)


def _tool_call_text(payload: dict[str, Any]) -> str:
    parts = [str(payload.get("tool_name") or "")]
    for key in ("args", "input", "arguments", "command", "parameters", "path", "content"):
        if payload.get(key):
            parts.append(str(payload[key]))
    return " ".join(parts)


def _ask_mode_tool_blocked(payload: dict[str, Any]) -> tuple[bool, str]:
    tool_name = str(payload.get("tool_name") or "").strip()
    normalized = tool_name.lower().replace("-", "_").split(".")[-1]
    blob = _tool_call_text(payload)

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

    if normalized in ASK_READ_ONLY_TOOL_NAMES:
        return False, ""

    return (
        True,
        "Ask mode allows read-only repo tools only. Switch to Execute for this action.",
    )
