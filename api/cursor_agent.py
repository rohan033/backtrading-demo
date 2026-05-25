"""Async Cursor SDK agent bridge for strategy / market Q&A."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from collections import OrderedDict
from typing import Any, AsyncIterator, Optional

from cursor_sdk import AsyncClient, CursorAgentError, LocalAgentOptions
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from control_plane.engine_process_manager import REPO_ROOT

log = logging.getLogger("backtrading.cursor_agent")

CURSOR_API_KEY_ENV = "CURSOR_API_KEY"
CURSOR_AGENT_MODEL_ENV = "CURSOR_AGENT_MODEL"
CURSOR_AGENT_WORKSPACE_ENV = "CURSOR_AGENT_WORKSPACE"
CURSOR_AGENT_MAX_SESSIONS_ENV = "CURSOR_AGENT_MAX_SESSIONS"

DEFAULT_MODEL = "composer-2.5"
MAX_AGENT_SESSIONS = 32

STRATEGY_AGENT_HINT = """You are the in-repo assistant for a backtrading / live-strategy platform.

Help the user with:
- Saved strategy executions and how they are deployed via the control plane
- Strategy configuration (entry trigger, take profit, stop loss, capital, partial stocks)
- Live price streams, data-plane engines, and broker integrations (Angel One, eToro)
- Stock / instrument context when it appears in this repository or control-plane data

Prefer answers grounded in this repo (`api/`, `frontend/`, `strategies/`, `control_plane/`, `brokers/`).
If you need to inspect files or logs, use available tools. Be concise and practical."""


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
        if not self.configured:
            log.warning(
                "[CURSOR_AGENT] %s is not set; cursor agent WebSocket is disabled",
                CURSOR_API_KEY_ENV,
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
                "message": f"Set {CURSOR_API_KEY_ENV} to enable the Cursor agent endpoint.",
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
        ws: WebSocket | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if not self.configured:
            yield {"type": "error", "phase": "config", "message": f"{CURSOR_API_KEY_ENV} is not set"}
            return

        user_prompt = prompt.strip()
        if not user_prompt:
            yield {"type": "error", "phase": "request", "message": "prompt is required"}
            return

        client = await self._require_client()
        created_new_agent = not agent_id

        try:
            agent = await self._get_or_create_agent(client, agent_id)
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

        message = _wrap_prompt(user_prompt, new_agent=created_new_agent)
        run = None

        try:
            run = await agent.send(message)
            yield {
                "type": "start",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "model": self.model(),
            }

            async for message_event in run.stream():
                if ws is not None and ws.client_state.name != "CONNECTED":
                    if run.supports("cancel"):
                        await run.cancel()
                    return

                payload = _sdk_message_payload(message_event)
                if not payload:
                    continue

                message_type = payload.get("message_type")
                if message_type == "assistant" and payload.get("text"):
                    yield {"type": "text_delta", "text": payload["text"]}
                elif message_type == "tool_call":
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

            yield {
                "type": "done",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "status": result.status,
                "text": result.result or await run.text(),
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

    async def _require_client(self) -> AsyncClient:
        if self._client is None:
            await self.startup()
        if self._client is None:
            raise RuntimeError(f"{CURSOR_API_KEY_ENV} is not configured")
        return self._client

    async def _get_or_create_agent(self, client: AsyncClient, agent_id: Optional[str]):
        from cursor_sdk import AgentOptions

        api_key = os.environ[CURSOR_API_KEY_ENV].strip()
        options = AgentOptions(
            api_key=api_key,
            model=self.model(),
            local=LocalAgentOptions(cwd=self.workspace()),
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
    return {"status": True, "data": await cursor_agent_service.health()}


async def handle_cursor_agent_websocket(ws: WebSocket) -> None:
    await ws.accept()
    log.info("[CURSOR_AGENT_WS] Client connected")
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

            log.info("[CURSOR_AGENT_WS] chat agent_id=%s prompt_len=%d", agent_id or "-", len(prompt))
            async for event in cursor_agent_service.stream_chat(
                prompt=prompt,
                agent_id=agent_id,
                ws=ws,
            ):
                await ws.send_json(event)
    except WebSocketDisconnect:
        log.info("[CURSOR_AGENT_WS] Client disconnected")
    except Exception as exc:
        log.exception("[CURSOR_AGENT_WS] Session error: %s", exc)
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "phase": "session", "message": str(exc)})


def _wrap_prompt(user_prompt: str, *, new_agent: bool) -> str:
    if not new_agent:
        return user_prompt
    return f"{STRATEGY_AGENT_HINT}\n\nUser question:\n{user_prompt}"


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
    elif message_type == "status":
        payload["status"] = getattr(message, "status", None)
        payload["message"] = getattr(message, "message", None)
    return payload
