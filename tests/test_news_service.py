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


def test_sec_filings_and_earnings_calendar(monkeypatch):
    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            store = NewsStore(db_path=os.path.join(tmp, "news.db"))
            service = NewsService(store=store)

            async def fake_get(path, params):
                if path == "/stock/filings":
                    return [{
                        "accessNumber": "0000320193-20-000052",
                        "symbol": params["symbol"],
                        "form": "10-K",
                        "filedDate": "2020-02-27 00:00:00",
                    }]
                raise AssertionError(f"unexpected path {path}")

            async def fake_get_object(path, params):
                assert path == "/calendar/earnings"
                assert params["symbol"] == "AAPL"
                return {
                    "earningsCalendar": [{
                        "date": "2025-01-30",
                        "symbol": "AAPL",
                        "epsActual": 2.4,
                        "epsEstimate": 2.35,
                        "hour": "amc",
                        "quarter": 1,
                        "year": 2025,
                    }],
                }

            monkeypatch.setattr("control_plane.news_service._finnhub_get", fake_get)
            monkeypatch.setattr("control_plane.news_service._finnhub_get_object", fake_get_object)

            filings = await service.sec_filings("AAPL")
            earnings = await service.earnings_calendar("AAPL")

            assert filings["data"][0]["form"] == "10-K"
            assert earnings["data"][0]["epsActual"] == 2.4

    asyncio.run(run())


def test_recommendation_trends_returns_sorted_rows(monkeypatch):
    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            store = NewsStore(db_path=os.path.join(tmp, "news.db"))
            service = NewsService(store=store)

            async def fake_get(path, params):
                assert path == "/stock/recommendation"
                assert params["symbol"] == "AAPL"
                return [
                    {
                        "buy": 17,
                        "hold": 13,
                        "period": "2025-02-01",
                        "sell": 5,
                        "strongBuy": 13,
                        "strongSell": 0,
                        "symbol": "AAPL",
                    },
                    {
                        "buy": 24,
                        "hold": 7,
                        "period": "2025-03-01",
                        "sell": 0,
                        "strongBuy": 13,
                        "strongSell": 0,
                        "symbol": "AAPL",
                    },
                ]

            monkeypatch.setattr("control_plane.news_service._finnhub_get", fake_get)
            payload = await service.recommendation_trends("aapl.us", limit=6)

            assert payload["meta"]["symbol"] == "AAPL"
            assert payload["data"][0]["period"] == "2025-03-01"
            assert payload["data"][1]["period"] == "2025-02-01"

            calls = {"count": 0}

            async def counting_get(path, params):
                calls["count"] += 1
                return await fake_get(path, params)

            monkeypatch.setattr("control_plane.news_service._finnhub_get", counting_get)
            cached_payload = await service.recommendation_trends("aapl.us", limit=6)
            assert cached_payload["meta"]["cached"] is True
            assert calls["count"] == 0

    asyncio.run(run())
