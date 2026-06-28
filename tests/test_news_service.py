import asyncio
import os
import tempfile

from fastapi import HTTPException

from control_plane.news_service import NewsService, finnhub_ticker
from control_plane.news_store import NewsStore


def _item(item_id: int, headline: str):
    return {
        "category": "company",
        "datetime": 1_700_000_000 + item_id,
        "headline": headline,
        "id": item_id,
        "image": "",
        "related": "AAPL",
        "source": "Finnhub",
        "summary": headline,
        "url": f"https://example.test/{item_id}",
    }


def test_finnhub_ticker_normalizes_watchlist_symbols():
    assert finnhub_ticker("RELIANCE-EQ") == "RELIANCE"
    assert finnhub_ticker("aapl.us") == "AAPL"


def test_company_news_seeds_cache_without_initial_notifications(monkeypatch):
    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            store = NewsStore(db_path=os.path.join(tmp, "news.db"))
            calls = {"count": 0}

            async def fake_get(path, params):
                calls["count"] += 1
                if calls["count"] == 1:
                    return [_item(1, "Existing headline")]
                return [_item(2, "New headline"), _item(1, "Existing headline")]

            monkeypatch.setattr("control_plane.news_service._finnhub_get", fake_get)
            service = NewsService(store=store)

            seeded = await service.company_news("AAPL", refresh=True, notify=True)
            refreshed = await service.company_news("AAPL", refresh=True, notify=True)

            assert seeded["notifications"] == []
            assert len(refreshed["notifications"]) == 1
            assert refreshed["notifications"][0]["headline"] == "New headline"

    asyncio.run(run())


def test_company_news_returns_stale_cache_on_refresh_failure(monkeypatch):
    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            store = NewsStore(db_path=os.path.join(tmp, "news.db"))
            service = NewsService(store=store)

            async def ok_get(path, params):
                return [_item(1, "Cached headline")]

            async def failing_get(path, params):
                raise HTTPException(status_code=429, detail="rate limited")

            monkeypatch.setattr("control_plane.news_service._finnhub_get", ok_get)
            await service.company_news("AAPL", refresh=True)
            monkeypatch.setattr("control_plane.news_service._finnhub_get", failing_get)

            stale = await service.company_news("AAPL", refresh=True)

            assert stale["data"][0]["headline"] == "Cached headline"
            assert stale["meta"]["stale"] is True

    asyncio.run(run())
