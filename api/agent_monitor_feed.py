"""WebSocket hub for proactive agent monitor AG-UI events."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger("backtrading")


class AgentMonitorFeedHub:
    def __init__(self) -> None:
        self._subscriptions: dict[str, set[WebSocket]] = {}

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()

    def subscribe(self, ws: WebSocket, thread_id: str) -> None:
        key = thread_id.strip()
        if not key:
            return
        self._subscriptions.setdefault(key, set()).add(ws)

    def unsubscribe(self, ws: WebSocket) -> None:
        dead_keys: list[str] = []
        for key, sockets in self._subscriptions.items():
            sockets.discard(ws)
            if not sockets:
                dead_keys.append(key)
        for key in dead_keys:
            self._subscriptions.pop(key, None)

    async def broadcast(self, thread_id: str, payload: dict[str, Any]) -> None:
        sockets = list(self._subscriptions.get(thread_id.strip(), set()))
        if not sockets:
            return
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(ws)

    async def handle(self, ws: WebSocket) -> None:
        await self.connect(ws)
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                    continue
                if msg.get("type") == "subscribe":
                    thread_id = str(msg.get("thread_id") or msg.get("threadId") or "").strip()
                    if thread_id:
                        self.subscribe(ws, thread_id)
                        await ws.send_json({"type": "subscribed", "threadId": thread_id})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.debug("[AGENT_MONITOR_WS] closed: %s", exc)
        finally:
            self.unsubscribe(ws)


_hub: AgentMonitorFeedHub | None = None


def get_agent_monitor_feed_hub() -> AgentMonitorFeedHub:
    global _hub
    if _hub is None:
        _hub = AgentMonitorFeedHub()
    return _hub
