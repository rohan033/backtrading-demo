import asyncio
import os
import tempfile

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api import market_news_routes
from control_plane.news_service import NewsService, finnhub_ticker
from control_plane.news_store import NewsStore


def _item(item_id: int, headline: str, ts: int = 1_700_000_000):
    return {
        "id": item_id,
        "headline": headline,
        "datetime": ts + item_id,
        "source": "TestWire",
        "summary": f"{headline} summary",
        "url": f"https://example.test/news/{item_id}",
        "category": "company",
        "image": "",
        "related": "AAPL",
    }


def test_finnhub_ticker_normalizes_watchlist_symbols():
    assert finnhub_ticker("RELIANCE-EQ") == "RELIANCE"
    assert finnhub_ticker("AAPL.US") == "AAPL"
    assert finnhub_ticker(" btc ") == "BTC"


def test_news_store_compresses_cache_and_dedupes_notifications():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "news.db")
        store = NewsStore(db_path=path)

        entry = store.set_cache(
            cache_key="company:AAPL:30",
            scope="company",
            topic="AAPL",
            days=30,
            items=[_item(1, "Seed")],
            fetched_at=123.0,
        )
        assert entry.item_ids == {1}
        assert store.get_cache("company:AAPL:30").items[0]["headline"] == "Seed"

        inserted = store.insert_notifications(
            scope="company",
            topic="AAPL",
            items=[_item(1, "Seed"), _item(2, "Fresh")],
            existing_item_ids={1},
        )
        assert [item["item_id"] for item in inserted] == [2]

        duplicate = store.insert_notifications(
            scope="company",
            topic="AAPL",
            items=[_item(2, "Fresh")],
            existing_item_ids=set(),
        )
        assert duplicate == []
        assert len(store.recent_notifications()) == 1


def test_company_news_first_seed_does_not_notify_then_new_item_notifies(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        store = NewsStore(db_path=os.path.join(tmp, "news.db"))
        service = NewsService(store=store)
        responses = [
            [_item(1, "Seed")],
            [_item(2, "Fresh"), _item(1, "Seed")],
        ]

        async def fake_finnhub_get(_path, _params):
            return responses.pop(0)

        monkeypatch.setattr("control_plane.news_service._finnhub_get", fake_finnhub_get)

        first = asyncio.run(service.company_news("AAPL", refresh=True, notify=True))
        assert first["notifications"] == []
        assert first["meta"]["cached"] is False

        second = asyncio.run(service.company_news("AAPL", refresh=True, notify=True))
        assert [item["item_id"] for item in second["notifications"]] == [2]


def test_company_news_uses_cache_and_manual_refresh(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        store = NewsStore(db_path=os.path.join(tmp, "news.db"))
        service = NewsService(store=store)
        calls = 0

        async def fake_finnhub_get(_path, _params):
            nonlocal calls
            calls += 1
            return [_item(calls, f"Fetch {calls}")]

        monkeypatch.setattr("control_plane.news_service._finnhub_get", fake_finnhub_get)

        first = asyncio.run(service.company_news("AAPL"))
        cached = asyncio.run(service.company_news("AAPL"))
        refreshed = asyncio.run(service.company_news("AAPL", refresh=True))

        assert calls == 2
        assert first["data"][0]["headline"] == "Fetch 1"
        assert cached["data"][0]["headline"] == "Fetch 1"
        assert cached["meta"]["cached"] is True
        assert refreshed["data"][0]["headline"] == "Fetch 2"


def test_company_news_returns_stale_cache_on_upstream_failure(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        store = NewsStore(db_path=os.path.join(tmp, "news.db"))
        service = NewsService(store=store)

        async def ok_finnhub_get(_path, _params):
            return [_item(1, "Seed")]

        async def failing_finnhub_get(_path, _params):
            raise HTTPException(status_code=502, detail="upstream down")

        monkeypatch.setattr("control_plane.news_service._finnhub_get", ok_finnhub_get)
        asyncio.run(service.company_news("AAPL"))
        monkeypatch.setattr("control_plane.news_service._finnhub_get", failing_finnhub_get)

        result = asyncio.run(service.company_news("AAPL", refresh=True))
        assert result["data"][0]["headline"] == "Seed"
        assert result["meta"]["cached"] is True
        assert result["meta"]["stale"] is True


def test_company_news_raises_when_key_missing_and_no_cache(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        store = NewsStore(db_path=os.path.join(tmp, "news.db"))
        service = NewsService(store=store)

        async def missing_key(_path, _params):
            raise HTTPException(status_code=503, detail="FINNHUB_API_KEY is not configured")

        monkeypatch.setattr("control_plane.news_service._finnhub_get", missing_key)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(service.company_news("AAPL"))
        assert exc.value.status_code == 503


def test_company_news_route_uses_service_refresh(monkeypatch):
    class FakeService:
        async def company_news(self, symbol, *, days=30, refresh=False, notify=False):
            return {
                "status": True,
                "data": [_item(9, f"{symbol}:{days}:{refresh}:{notify}")],
                "meta": {"symbol": symbol, "count": 1},
            }

    monkeypatch.setattr(market_news_routes, "get_news_service", lambda: FakeService())
    app = FastAPI()
    app.include_router(market_news_routes.router)
    client = TestClient(app)

    response = client.get("/api/market/company-news?symbol=AAPL&days=7&refresh=true")

    assert response.status_code == 200
    assert response.json()["data"][0]["headline"] == "AAPL:7:True:False"
