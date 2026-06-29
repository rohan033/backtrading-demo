from datetime import date

from control_plane.earnings_monitor import build_earnings_monitors, parse_earnings_date


def test_parse_earnings_date():
    assert parse_earnings_date("2026-07-23") == date(2026, 7, 23)
    assert parse_earnings_date("2026-07-23 00:00:00") == date(2026, 7, 23)
    assert parse_earnings_date("") is None


def test_build_earnings_monitors_post_earnings_day():
    today = date(2026, 7, 24)
    events = [
        {
            "symbol": "INTC",
            "date": "2026-07-23",
            "hour": "amc",
            "quarter": 2,
            "year": 2026,
            "watchlistRefs": [{"tradingsymbol": "INTC", "symboltoken": "100077"}],
        }
    ]
    monitors = build_earnings_monitors(events, today=today)
    assert len(monitors) == 1
    assert monitors[0]["phase"] == "post_earnings"
    assert monitors[0]["symbol"] == "INTC"


def test_build_earnings_monitors_earnings_today():
    today = date(2026, 7, 23)
    events = [
        {
            "symbol": "AAPL",
            "date": "2026-07-23",
            "hour": "bmo",
            "watchlistRefs": [],
        }
    ]
    monitors = build_earnings_monitors(events, today=today)
    assert len(monitors) == 1
    assert monitors[0]["phase"] == "earnings_today"


def test_watchlist_earnings_aggregates_symbols(monkeypatch):
    import asyncio

    async def run():
        from control_plane.news_service import NewsService
        from control_plane.news_store import NewsStore
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            store = NewsStore(db_path=os.path.join(tmp, "news.db"))
            service = NewsService(store=store)

            class FakeWatchlistStore:
                def list_watchlists(self):
                    return [{
                        "id": "wl-1",
                        "broker": "etoro",
                        "account_env": "demo",
                        "symbols": [
                            {"tradingsymbol": "INTC", "symboltoken": "100077"},
                            {"tradingsymbol": "AAPL", "symboltoken": "100001"},
                        ],
                    }]

            async def fake_calendar(symbol, *, past_days=14, future_days=90):
                return {
                    "data": [{
                        "symbol": symbol,
                        "date": "2026-07-23",
                        "hour": "amc",
                        "quarter": 2,
                        "year": 2026,
                    }],
                }

            monkeypatch.setattr("control_plane.news_service.get_watchlist_store", lambda: FakeWatchlistStore())
            monkeypatch.setattr(service, "earnings_calendar", fake_calendar)

            payload = await service.watchlist_earnings(request_delay_seconds=0)
            assert payload["meta"]["tickerCount"] == 2
            assert payload["meta"]["eventCount"] == 2
            assert payload["data"][0]["watchlistRefs"]

    asyncio.run(run())
