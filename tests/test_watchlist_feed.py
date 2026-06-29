import asyncio

import pytest

from api.watchlist_feed import (
    WatchlistFeedHub,
    market_preview_uses_shared_hub,
    preview_subscription_from_msg,
)


class FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[dict] = []
        self.closed = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.parametrize(
    ("cfg", "expected"),
    [
        ({"broker": "etoro", "token": "1", "symbol": "NVDA"}, True),
        ({"use_fake_client": True, "broker": "etoro", "token": "1", "symbol": "NVDA"}, False),
        ({"broker": "fake", "token": "1", "symbol": "TEST"}, False),
        ({"broker": "angel", "token": "1", "symbol": "TCS", "feed_mode": "websocket"}, True),
        ({"broker": "angel", "token": "1", "symbol": "TCS", "feed_mode": "rest"}, False),
    ],
)
def test_market_preview_uses_shared_hub(cfg, expected):
    assert market_preview_uses_shared_hub(cfg) is expected


def test_preview_subscription_from_msg_defaults_etoro_demo():
    preview = preview_subscription_from_msg(
        {"broker": "etoro", "token": "123", "symbol": "NVDA", "exchange": "ETORO"},
    )
    assert preview.broker == "etoro"
    assert preview.account_env == "demo"
    assert preview.token == "123"
    assert preview.symbol == "NVDA"


@pytest.mark.asyncio
async def test_watchlist_snapshot_sent_on_sync(monkeypatch):
    hub = WatchlistFeedHub()
    ws = FakeWebSocket()

    async def noop_start(self, subscriptions, on_tick):
        self.client = object()

    async def noop_sync(self, subscriptions):
        self.subscriptions = {str(s.token): s for s in subscriptions}

    async def noop_stop(self):
        self.client = None

    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.start", noop_start)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.sync", noop_sync)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.stop", noop_stop)

    hub._last_tick_payload["etoro:demo:123"] = {
        "type": "tick",
        "broker": "etoro",
        "account_env": "demo",
        "token": "123",
        "symbol": "NVDA",
        "exchange": "ETORO",
        "ltp": 194.5,
        "change_pct": 0.1,
        "direction": "up",
    }

    watchlists = [{
        "broker": "etoro",
        "account_env": "demo",
        "symbols": [{
            "symboltoken": "123",
            "tradingsymbol": "NVDA",
            "exchange": "ETORO",
            "symbol": "NVDA",
        }],
    }]

    await hub.connect(ws)
    await hub.set_client_watchlists(ws, watchlists)

    snapshot_msgs = [msg for msg in ws.sent if msg.get("type") == "snapshot"]
    assert len(snapshot_msgs) == 1
    assert snapshot_msgs[0]["ticks"][0]["ltp"] == 194.5


@pytest.mark.asyncio
async def test_idle_shutdown_waits_before_stopping_feeds(monkeypatch):
    short_idle = 0.05
    monkeypatch.setattr("api.watchlist_feed.FEED_IDLE_SHUTDOWN_SEC", short_idle)

    hub = WatchlistFeedHub()
    stop_calls: list[str] = []

    async def track_start(self, subscriptions, on_tick):
        self.client = object()

    async def track_sync(self, subscriptions):
        self.subscriptions = {str(s.token): s for s in subscriptions}

    async def track_stop(self):
        stop_calls.append(self.key)
        self.client = None

    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.start", track_start)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.sync", track_sync)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.stop", track_stop)

    ws = FakeWebSocket()
    watchlists = [{
        "broker": "etoro",
        "account_env": "demo",
        "symbols": [{"symboltoken": "123", "tradingsymbol": "NVDA", "exchange": "ETORO"}],
    }]

    await hub.connect(ws)
    await hub.set_client_watchlists(ws, watchlists)
    assert hub._feeds

    hub.disconnect(ws)
    await hub._rebuild_feeds()
    assert hub._feeds, "feeds should remain during idle grace period"

    await asyncio.sleep(short_idle + 0.05)
    assert not hub._feeds
    assert stop_calls == ["etoro:demo"]


@pytest.mark.asyncio
async def test_idle_shutdown_cancelled_when_client_returns(monkeypatch):
    short_idle = 0.2
    monkeypatch.setattr("api.watchlist_feed.FEED_IDLE_SHUTDOWN_SEC", short_idle)

    hub = WatchlistFeedHub()
    stop_calls: list[str] = []

    async def track_start(self, subscriptions, on_tick):
        self.client = object()

    async def track_sync(self, subscriptions):
        self.subscriptions = {str(s.token): s for s in subscriptions}

    async def track_stop(self):
        stop_calls.append(self.key)
        self.client = None

    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.start", track_start)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.sync", track_sync)
    monkeypatch.setattr("api.watchlist_feed._BrokerFeed.stop", track_stop)

    ws1 = FakeWebSocket()
    watchlists = [{
        "broker": "etoro",
        "account_env": "demo",
        "symbols": [{"symboltoken": "123", "tradingsymbol": "NVDA", "exchange": "ETORO"}],
    }]

    await hub.connect(ws1)
    await hub.set_client_watchlists(ws1, watchlists)
    hub.disconnect(ws1)
    await hub._rebuild_feeds()

    await asyncio.sleep(0.05)
    ws2 = FakeWebSocket()
    await hub.connect(ws2)
    await hub.set_client_watchlists(ws2, watchlists)

    await asyncio.sleep(short_idle + 0.05)
    assert hub._feeds
    assert stop_calls == []
