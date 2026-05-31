"""Multi-broker websocket feeds for watchlist clients."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from brokers.interfaces import Subscription, TickData

log = logging.getLogger("backtrading")


def _feed_key(broker: str, account_env: str) -> str:
    return f"{(broker or 'angel').lower()}:{(account_env or 'live').lower()}"


def _tick_cache_key(broker: str, account_env: str, token: str) -> str:
    return f"{_feed_key(broker, account_env)}:{token}"


def _subscriptions_from_watchlists(
    watchlists: list[dict[str, Any]],
) -> dict[str, dict[str, Subscription]]:
    """feed_key -> token -> Subscription"""
    grouped: dict[str, dict[str, Subscription]] = {}
    for watchlist in watchlists:
        broker = (watchlist.get("broker") or "angel").lower()
        account_env = watchlist.get("account_env") or ("demo" if broker == "etoro" else "live")
        key = _feed_key(broker, account_env)
        bucket = grouped.setdefault(key, {})
        for symbol in watchlist.get("symbols") or []:
            token = str(symbol.get("symboltoken") or "").strip()
            if not token:
                continue
            bucket[token] = Subscription(
                exchange=str(symbol.get("exchange") or ("ETORO" if broker == "etoro" else "NSE")),
                symbol=str(symbol.get("symbol") or symbol.get("tradingsymbol") or ""),
                token=token,
            )
    return grouped


class _BrokerFeed:
    def __init__(self, broker: str, account_env: str) -> None:
        self.broker = broker
        self.account_env = account_env
        self.key = _feed_key(broker, account_env)
        self.subscriptions: dict[str, Subscription] = {}
        self.client: Any = None

    async def start(self, subscriptions: list[Subscription], on_tick) -> None:
        self.subscriptions = {str(s.token): s for s in subscriptions}
        if self.broker == "etoro":
            from brokers.etoro.feed_client import EtoroWebsocketFeedClient

            feed = EtoroWebsocketFeedClient(account_env=self.account_env)
            feed.add_tick_callback(on_tick)
            await feed.start()
            for sub in subscriptions:
                await feed.subscribe(sub.exchange, sub.symbol, sub.token)
            self.client = feed
            log.info("[WATCHLIST] eToro feed started env=%s symbols=%d", self.account_env, len(subscriptions))
            return

        from brokers.angel.feed_client import AngelWebsocketFeedClient
        from brokers.angel.trading_client import AngelOneTradingClient

        angel_client = AngelOneTradingClient()
        angel_client.generate_session()
        feed = AngelWebsocketFeedClient.from_trading_client(angel_client)
        feed.add_tick_callback(on_tick)
        await feed.start()
        await feed.sync_subscriptions(subscriptions)
        self.client = feed
        log.info("[WATCHLIST] Angel feed started symbols=%d", len(subscriptions))

    async def sync(self, subscriptions: list[Subscription]) -> None:
        self.subscriptions = {str(s.token): s for s in subscriptions}
        if self.client is None:
            return
        if self.broker == "etoro":
            current = set(self.subscriptions)
            for sub in subscriptions:
                await self.client.subscribe(sub.exchange, sub.symbol, sub.token)
            return
        await self.client.sync_subscriptions(subscriptions)

    async def stop(self) -> None:
        if self.client is None:
            return
        try:
            await self.client.stop()
        except Exception as exc:
            log.warning("[WATCHLIST] feed stop error key=%s: %s", self.key, exc)
        self.client = None


class WatchlistFeedHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._clients: dict[int, list[dict[str, Any]]] = {}
        self._feeds: dict[str, _BrokerFeed] = {}
        self._previous_ltp: dict[str, float] = {}
        self._tick_queue: asyncio.Queue[tuple[str, str, TickData]] | None = None
        self._broadcast_task: asyncio.Task | None = None
        self._active_connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._active_connections.add(ws)
        if self._broadcast_task is None:
            self._tick_queue = asyncio.Queue()
            self._broadcast_task = asyncio.create_task(self._broadcast_loop())

    def disconnect(self, ws: WebSocket) -> None:
        self._active_connections.discard(ws)
        self._clients.pop(id(ws), None)
        if not self._active_connections and self._broadcast_task is not None:
            self._broadcast_task.cancel()
            self._broadcast_task = None
            self._tick_queue = None

    async def set_client_watchlists(self, ws: WebSocket, watchlists: list[dict[str, Any]]) -> None:
        self._clients[id(ws)] = watchlists
        await self._rebuild_feeds()

    async def _rebuild_feeds(self) -> None:
        async with self._lock:
            grouped: dict[str, dict[str, Subscription]] = {}
            for watchlists in self._clients.values():
                for key, bucket in _subscriptions_from_watchlists(watchlists).items():
                    grouped.setdefault(key, {}).update(bucket)

            active_keys = set(grouped)
            for key in list(self._feeds):
                if key not in active_keys:
                    await self._feeds[key].stop()
                    del self._feeds[key]
                    prefix = f"{key}:"
                    for cache_key in list(self._previous_ltp):
                        if cache_key.startswith(prefix):
                            self._previous_ltp.pop(cache_key, None)

            for key, subs in grouped.items():
                broker, account_env = key.split(":", 1)
                subscription_list = list(subs.values())
                if not subscription_list:
                    continue

                if key not in self._feeds:

                    async def on_tick(tick: TickData, _key=key) -> None:
                        if self._tick_queue is not None:
                            b, env = _key.split(":", 1)
                            await self._tick_queue.put((b, env, tick))

                    feed = _BrokerFeed(broker, account_env)
                    await feed.start(subscription_list, on_tick)
                    self._feeds[key] = feed
                else:
                    await self._feeds[key].sync(subscription_list)

            if not grouped:
                for feed in list(self._feeds.values()):
                    await feed.stop()
                self._feeds.clear()

    async def _broadcast_loop(self) -> None:
        assert self._tick_queue is not None
        try:
            while True:
                broker, account_env, tick = await self._tick_queue.get()
                await self._broadcast_tick(broker, account_env, tick)
        except asyncio.CancelledError:
            raise

    async def _broadcast_tick(self, broker: str, account_env: str, tick: TickData) -> None:
        token = str(tick.token)
        ltp = float(tick.ltp or 0)
        if ltp <= 0:
            return

        cache_key = _tick_cache_key(broker, account_env, token)
        prev = self._previous_ltp.get(cache_key)
        if prev is not None and prev > 0:
            change_pct = ((ltp - prev) / prev) * 100.0
        else:
            change_pct = 0.0
        self._previous_ltp[cache_key] = ltp

        if change_pct > 0:
            direction = "up"
        elif change_pct < 0:
            direction = "down"
        else:
            direction = "flat"

        payload = {
            "type": "tick",
            "broker": broker,
            "account_env": account_env,
            "token": token,
            "symbol": tick.symbol,
            "exchange": tick.exchange,
            "ltp": ltp,
            "change_pct": round(change_pct, 2),
            "direction": direction,
        }

        dead: list[WebSocket] = []
        for ws in list(self._active_connections):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
            await self._rebuild_feeds()

    async def handle(self, ws: WebSocket) -> None:
        await self.connect(ws)
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "sync":
                    watchlists = msg.get("watchlists") or []
                    await self.set_client_watchlists(ws, watchlists)
                    symbol_count = sum(len(wl.get("symbols") or []) for wl in watchlists)
                    await ws.send_json({"type": "synced", "symbol_count": symbol_count})
        except WebSocketDisconnect:
            pass
        finally:
            self.disconnect(ws)
            await self._rebuild_feeds()


_hub: WatchlistFeedHub | None = None


def get_watchlist_feed_hub() -> WatchlistFeedHub:
    global _hub
    if _hub is None:
        _hub = WatchlistFeedHub()
    return _hub
