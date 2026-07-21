from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger("backtrading")


class TradeHaltsFeedHub:
    def __init__(self) -> None:
        self._active_connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._active_connections.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._active_connections.discard(ws)

    async def broadcast_notifications(self, notifications: list[dict[str, Any]]) -> None:
        if not notifications or not self._active_connections:
            return
        payload = {
            "type": "trade_halts",
            "notifications": notifications,
        }
        dead: list[WebSocket] = []
        for ws in list(self._active_connections):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def handle(self, ws: WebSocket) -> None:
        await self.connect(ws)
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.debug("[HALTS] websocket closed after error: %s", exc)
        finally:
            self.disconnect(ws)


_hub: TradeHaltsFeedHub | None = None


def get_trade_halts_feed_hub() -> TradeHaltsFeedHub:
    global _hub
    if _hub is None:
        _hub = TradeHaltsFeedHub()
    return _hub
