"""Thin Cursor SDK bridge: shared client lifecycle and prompt-in, events-out runs."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from collections import OrderedDict
from typing import Any, AsyncIterator, Optional

from cursor_sdk import AsyncClient, CursorAgentError, LocalAgentOptions

from api.workspace_media import attachments_from_paths, extract_media_paths_from_text
from control_plane.engine_process_manager import REPO_ROOT

log = logging.getLogger("backtrading.cursor_sdk")

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


def control_plane_mcp_servers() -> dict[str, Any] | None:
    """HTTP MCP config for control-plane tools."""
    from cursor_sdk import HttpMcpServerConfig

    from api.control_plane_mcp import CONTROL_PLANE_MCP_PATH
    from api.control_plane_mcp_tools import CONTROL_PLANE_MCP_SERVER

    control_plane_url = os.getenv("CONTROL_PLANE_URL", "http://127.0.0.1:8000").strip().rstrip("/")
    return {
        CONTROL_PLANE_MCP_SERVER: HttpMcpServerConfig(
            url=f"{control_plane_url}{CONTROL_PLANE_MCP_PATH}",
        )
    }


def sdk_message_payload(message: Any) -> dict[str, Any] | None:
    message_type = getattr(message, "type", None)
    if not message_type:
        return None

    payload: dict[str, Any] = {"message_type": message_type}
    if message_type == "assistant":
        blocks = getattr(getattr(message, "message", None), "content", ()) or ()
        text_parts: list[str] = []
        media_paths: list[str] = []
        for block in blocks:
            block_type = getattr(block, "type", None)
            if block_type == "image":
                for attr in ("path", "file_path", "url", "source", "image_url"):
                    value = getattr(block, attr, None)
                    if isinstance(value, str) and value.strip():
                        media_paths.append(value.strip())
                        break
                continue
            text_parts.append(getattr(block, "text", ""))
        payload["text"] = "".join(text_parts)
        combined_paths = extract_media_paths_from_text(payload["text"]) + media_paths
        payload["media_paths"] = [
            row["path"]
            for row in attachments_from_paths(combined_paths)
        ]
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


class CursorSdkBridge:
    """Shared Cursor SDK client with per-consumer agent session pools."""

    def __init__(self) -> None:
        self._client: AsyncClient | None = None
        self._client_lock = asyncio.Lock()
        self._pools: dict[str, OrderedDict[str, Any]] = {}
        self._pools_lock = asyncio.Lock()

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
                "[CURSOR_SDK] %s is not set; add it to %s to enable Cursor agents",
                CURSOR_API_KEY_ENV,
                CURSOR_API_ENV_FILE,
            )
            return

        async with self._client_lock:
            if self._client is not None:
                return
            workspace = self.workspace()
            log.info("[CURSOR_SDK] Launching SDK bridge workspace=%s model=%s", workspace, self.model())
            self._client = await AsyncClient.launch_bridge(workspace=workspace)

    async def shutdown(self) -> None:
        async with self._pools_lock:
            pool_items = [(session_name, list(pool.items())) for session_name, pool in self._pools.items()]
            self._pools.clear()

        for session_name, agents in pool_items:
            for agent_id, agent in agents:
                await self._close_agent_instance(agent, agent_id, reason=f"shutdown:{session_name}")

        async with self._client_lock:
            client = self._client
            self._client = None
            if client is not None:
                await client.aclose()
                log.info("[CURSOR_SDK] SDK bridge closed")

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
            log.warning("[CURSOR_SDK] Health check failed: %s", exc)
            return {
                "configured": True,
                "ready": False,
                "api_key_env": CURSOR_API_KEY_ENV,
                "workspace": self.workspace(),
                "model": self.model(),
                "message": str(exc),
            }

        active_sessions = sum(len(pool) for pool in self._pools.values())
        return {
            "configured": True,
            "ready": True,
            "api_key_env": CURSOR_API_KEY_ENV,
            "workspace": self.workspace(),
            "model": self.model(),
            "ping": ping,
            "version": version,
            "active_sessions": active_sessions,
        }

    async def stream_run(
        self,
        *,
        session_name: str,
        prompt: str,
        agent_id: Optional[str] = None,
        mcp_servers: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        active_run: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Run a fully-formed prompt through Cursor SDK and yield generic events."""
        if not self.configured:
            yield {"type": "error", "phase": "config", "message": CURSOR_CONFIG_HINT}
            return

        message = prompt.strip()
        if not message:
            yield {"type": "error", "phase": "request", "message": "prompt is required"}
            return

        client = await self._require_client()
        created_new_agent = not agent_id
        run = None

        try:
            agent = await self._get_or_create_agent(
                client,
                session_name,
                agent_id,
                mcp_servers=mcp_servers,
            )
        except CursorAgentError as exc:
            log.error("[CURSOR_SDK] Agent startup failed session=%s: %s", session_name, exc)
            yield {
                "type": "error",
                "phase": "startup",
                "message": exc.message,
                "retryable": exc.is_retryable,
            }
            return
        except Exception as exc:
            log.exception("[CURSOR_SDK] Unexpected agent startup failure session=%s", session_name)
            yield {"type": "error", "phase": "startup", "message": str(exc)}
            return

        try:
            from cursor_sdk import SendOptions

            send_options = SendOptions(mode="agent")
            if mcp_servers is not None:
                send_options = SendOptions(mode="agent", mcp_servers=mcp_servers)
            run = await agent.send(message, send_options)
            if active_run is not None:
                active_run["run"] = run

            yield {
                "type": "start",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "model": self.model(),
                "new_agent": created_new_agent,
                "session_name": session_name,
            }

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

                payload = sdk_message_payload(message_event)
                if not payload:
                    continue

                message_type = payload.get("message_type")
                if message_type == "assistant":
                    if payload.get("text"):
                        assistant_chunks.append(payload["text"])
                        yield {"type": "text_delta", "text": payload["text"]}
                    if payload.get("media_paths"):
                        yield {"type": "media", "media_paths": payload["media_paths"]}
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

            final_text = result.result or await run.text() or "".join(assistant_chunks)
            yield {
                "type": "done",
                "agent_id": agent.agent_id,
                "run_id": run.id,
                "status": result.status,
                "text": final_text,
            }
        except CursorAgentError as exc:
            log.error("[CURSOR_SDK] Run failed session=%s agent=%s: %s", session_name, agent_id, exc)
            yield {
                "type": "error",
                "phase": "startup",
                "agent_id": getattr(agent, "agent_id", agent_id),
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
            log.exception("[CURSOR_SDK] Streaming failure session=%s", session_name)
            yield {
                "type": "error",
                "phase": "stream",
                "agent_id": getattr(agent, "agent_id", agent_id),
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
        session_name: str,
        agent_id: Optional[str],
        *,
        mcp_servers: dict[str, Any] | None,
    ):
        from cursor_sdk import AgentOptions

        api_key = os.environ[CURSOR_API_KEY_ENV].strip()
        options = AgentOptions(
            api_key=api_key,
            model=self.model(),
            local=LocalAgentOptions(cwd=self.workspace()),
            mode="agent",
            mcp_servers=mcp_servers,
        )

        pool = self._pool(session_name)
        if agent_id:
            cached = pool.get(agent_id)
            if cached is not None:
                pool.move_to_end(agent_id)
                return cached

            agent = await client.agents.resume(agent_id, options)
            await self._remember_agent(session_name, agent)
            return agent

        agent = await client.agents.create(options)
        await self._remember_agent(session_name, agent)
        return agent

    def _pool(self, session_name: str) -> OrderedDict[str, Any]:
        if session_name not in self._pools:
            self._pools[session_name] = OrderedDict()
        return self._pools[session_name]

    async def _remember_agent(self, session_name: str, agent) -> None:
        async with self._pools_lock:
            pool = self._pool(session_name)
            pool[agent.agent_id] = agent
            pool.move_to_end(agent.agent_id)
            while len(pool) > self.max_sessions():
                old_id, old_agent = pool.popitem(last=False)
                await self._close_agent_instance(old_agent, old_id, reason=f"evicted:{session_name}")

    async def _close_agent_instance(self, agent, agent_id: str, *, reason: str) -> None:
        try:
            await agent.close()
        except Exception as exc:
            log.warning("[CURSOR_SDK] Failed to close agent=%s (%s): %s", agent_id, reason, exc)


cursor_sdk_bridge = CursorSdkBridge()
