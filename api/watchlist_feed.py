"""Multi-broker websocket feeds for watchlist and market-preview clients."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from brokers.interfaces import Subscription, TickData

log = logging.getLogger("backtrading")

FEED_IDLE_SHUTDOWN_SEC = 60


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


@dataclass(frozen=True)
class PreviewSubscription:
    broker: str
    account_env: str
    token: str
    symbol: str
    exchange: str


def preview_subscription_from_msg(msg: dict[str, Any]) -> PreviewSubscription:
    broker = "fake" if msg.get("use_fake_client") else (msg.get("broker") or "angel").lower()
    account_env = msg.get("account_env") or ("demo" if broker == "etoro" else "live")
    return PreviewSubscription(
        broker=broker,
        account_env=str(account_env),
        token=str(msg["token"]),
        symbol=str(msg["symbol"]),
        exchange=str(msg.get("exchange") or ("ETORO" if broker == "etoro" else "NSE")),
    )


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

            feed = EtoroWebsocketFeedClient(account_env=self.account_env, sample_every=1)
            feed.add_tick_callback(on_tick)
            await feed.start()
            for sub in subscriptions:
                try:
                    await feed.subscribe(sub.exchange, sub.symbol, sub.token)
                except Exception as exc:
                    log.warning(
                        "[WATCHLIST] eToro subscribe failed symbol=%s token=%s: %s",
                        sub.symbol,
                        sub.token,
                        exc,
                    )
            self.client = feed
            log.info("[WATCHLIST] eToro websocket feed started env=%s symbols=%d", self.account_env, len(subscriptions))
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
        self._watchlist_clients: dict[int, tuple[WebSocket, list[dict[str, Any]]]] = {}
        self._preview_clients: dict[int, tuple[WebSocket, PreviewSubscription | None]] = {}
        self._feeds: dict[str, _BrokerFeed] = {}
        self._previous_ltp: dict[str, float] = {}
        self._last_tick_payload: dict[str, dict[str, Any]] = {}
        self._tick_queue: asyncio.Queue[tuple[str, str, TickData]] | None = None
        self._broadcast_task: asyncio.Task | None = None
        self._idle_shutdown_task: asyncio.Task | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._watchlist_clients[id(ws)] = (ws, [])
        self._cancel_idle_shutdown()
        self._ensure_broadcast_loop()

    def disconnect(self, ws: WebSocket) -> None:
        self._watchlist_clients.pop(id(ws), None)

    async def set_client_watchlists(self, ws: WebSocket, watchlists: list[dict[str, Any]]) -> None:
        self._watchlist_clients[id(ws)] = (ws, watchlists)
        await self._rebuild_feeds()
        await self._send_watchlist_snapshot(ws, watchlists)

    def _collect_grouped_subscriptions(self) -> dict[str, dict[str, Subscription]]:
        grouped: dict[str, dict[str, Subscription]] = {}
        for _, watchlists in self._watchlist_clients.values():
            for key, bucket in _subscriptions_from_watchlists(watchlists).items():
                grouped.setdefault(key, {}).update(bucket)
        for _, preview in self._preview_clients.values():
            if preview is None:
                continue
            key = _feed_key(preview.broker, preview.account_env)
            grouped.setdefault(key, {})[preview.token] = Subscription(
                exchange=preview.exchange,
                symbol=preview.symbol,
                token=preview.token,
            )
        return grouped

    async def _rebuild_feeds(self) -> None:
        async with self._lock:
            grouped = self._collect_grouped_subscriptions()
            if not grouped:
                await self._schedule_idle_shutdown()
                return

            self._cancel_idle_shutdown()
            self._ensure_broadcast_loop()

            active_keys = set(grouped)
            for key in list(self._feeds):
                if key not in active_keys:
                    await self._feeds[key].stop()
                    del self._feeds[key]
                    prefix = f"{key}:"
                    for cache_key in list(self._previous_ltp):
                        if cache_key.startswith(prefix):
                            self._previous_ltp.pop(cache_key, None)
                    for cache_key in list(self._last_tick_payload):
                        if cache_key.startswith(prefix):
                            self._last_tick_payload.pop(cache_key, None)

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

    def _ensure_broadcast_loop(self) -> None:
        if self._broadcast_task is None:
            self._tick_queue = asyncio.Queue()
            self._broadcast_task = asyncio.create_task(self._broadcast_loop())

    def _cancel_idle_shutdown(self) -> None:
        if self._idle_shutdown_task is not None:
            self._idle_shutdown_task.cancel()
            self._idle_shutdown_task = None

    async def _schedule_idle_shutdown(self) -> None:
        self._cancel_idle_shutdown()
        self._idle_shutdown_task = asyncio.create_task(self._idle_shutdown_worker())

    async def _idle_shutdown_worker(self) -> None:
        try:
            await asyncio.sleep(FEED_IDLE_SHUTDOWN_SEC)
            async with self._lock:
                if self._collect_grouped_subscriptions():
                    return
                for feed in list(self._feeds.values()):
                    await feed.stop()
                self._feeds.clear()
                log.info("[WATCHLIST] broker feeds stopped after %ss idle", FEED_IDLE_SHUTDOWN_SEC)
        except asyncio.CancelledError:
            raise

    async def _broadcast_loop(self) -> None:
        assert self._tick_queue is not None
        try:
            while True:
                broker, account_env, tick = await self._tick_queue.get()
                await self._broadcast_tick(broker, account_env, tick)
        except asyncio.CancelledError:
            raise

    def _build_watchlist_payload(
        self,
        broker: str,
        account_env: str,
        tick: TickData,
        ltp: float,
        change_pct: float,
        direction: str,
    ) -> dict[str, Any]:
        token = str(tick.token)
        return {
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

    def _build_preview_payload(self, tick: TickData, ltp: float) -> dict[str, Any]:
        return {
            "type": "tick",
            "symbol": tick.symbol,
            "token": str(tick.token),
            "exchange": tick.exchange,
            "ltp": ltp,
        }

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

        watchlist_payload = self._build_watchlist_payload(
            broker,
            account_env,
            tick,
            ltp,
            change_pct,
            direction,
        )
        preview_payload = self._build_preview_payload(tick, ltp)
        self._last_tick_payload[cache_key] = watchlist_payload

        dead_watchlist: list[WebSocket] = []
        for ws, _ in list(self._watchlist_clients.values()):
            try:
                await ws.send_json(watchlist_payload)
            except Exception:
                dead_watchlist.append(ws)

        dead_preview: list[int] = []
        for client_id, (pws, preview) in list(self._preview_clients.items()):
            if preview is None:
                continue
            if (
                preview.broker != broker
                or preview.account_env != account_env
                or preview.token != token
            ):
                continue
            try:
                await pws.send_json(preview_payload)
            except Exception:
                dead_preview.append(client_id)

        for ws in dead_watchlist:
            self.disconnect(ws)
        for client_id in dead_preview:
            self._preview_clients.pop(client_id, None)

        if dead_watchlist or dead_preview:
            await self._rebuild_feeds()

    async def _send_watchlist_snapshot(self, ws: WebSocket, watchlists: list[dict[str, Any]]) -> None:
        ticks: list[dict[str, Any]] = []
        for key, bucket in _subscriptions_from_watchlists(watchlists).items():
            broker, account_env = key.split(":", 1)
            for token in bucket:
                cache_key = _tick_cache_key(broker, account_env, token)
                payload = self._last_tick_payload.get(cache_key)
                if payload:
                    ticks.append(payload)
        if not ticks:
            return
        try:
            await ws.send_json({"type": "snapshot", "ticks": ticks})
        except Exception:
            self.disconnect(ws)

    async def _send_preview_snapshot(self, ws: WebSocket, preview: PreviewSubscription) -> None:
        cache_key = _tick_cache_key(preview.broker, preview.account_env, preview.token)
        payload = self._last_tick_payload.get(cache_key)
        if not payload:
            return
        try:
            await ws.send_json(self._build_preview_payload(
                TickData(
                    symbol=str(payload.get("symbol") or preview.symbol),
                    token=str(payload.get("token") or preview.token),
                    exchange=str(payload.get("exchange") or preview.exchange),
                    ltp=float(payload["ltp"]),
                ),
                float(payload["ltp"]),
            ))
        except Exception:
            self._preview_clients.pop(id(ws), None)

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

    async def set_market_preview_subscription(self, ws: WebSocket, msg: dict[str, Any]) -> None:
        preview = preview_subscription_from_msg(msg)
        self._preview_clients[id(ws)] = (ws, preview)
        self._cancel_idle_shutdown()
        self._ensure_broadcast_loop()
        log.info(
            "[CONTROL_MARKET] subscribe broker=%s symbol=%s token=%s (shared hub)",
            preview.broker,
            preview.symbol,
            preview.token,
        )
        await self._rebuild_feeds()
        await self._send_preview_snapshot(ws, preview)

    async def clear_market_preview_subscription(self, ws: WebSocket) -> None:
        if id(ws) not in self._preview_clients:
            return
        self._preview_clients.pop(id(ws), None)
        await self._rebuild_feeds()


_hub: WatchlistFeedHub | None = None


def get_watchlist_feed_hub() -> WatchlistFeedHub:
    global _hub
    if _hub is None:
        _hub = WatchlistFeedHub()
    return _hub


def market_preview_uses_shared_hub(cfg: dict[str, Any]) -> bool:
    if cfg.get("use_fake_client"):
        return False
    broker = (cfg.get("broker") or "angel").lower()
    if broker == "fake":
        return False
    if broker == "etoro":
        return True
    if broker == "angel":
        from brokers.angel.feed_config import angel_uses_websocket_feed

        return angel_uses_websocket_feed(cfg.get("feed_mode"))
    return False
