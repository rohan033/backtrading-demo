from datetime import date, timedelta

import os
import tempfile
import asyncio

from control_plane.insider_store import InsiderStore, transaction_key


def test_transaction_key_is_stable():
    row = {
        "name": "Jane Doe",
        "transactionDate": "2026-03-17",
        "filingDate": "2026-03-19",
        "change": -1250,
        "transactionCode": "S",
        "transactionPrice": 655.81,
    }
    assert transaction_key("TSLA", row) == transaction_key("TSLA", row)


def test_upsert_and_list_transactions():
    recent = (date.today() - timedelta(days=7)).isoformat()
    with tempfile.TemporaryDirectory() as tmp:
        store = InsiderStore(db_path=os.path.join(tmp, "insider.db"))
        rows = [{
            "name": "Jane Doe",
            "share": 57234,
            "change": -1250,
            "filingDate": recent,
            "transactionDate": recent,
            "transactionCode": "S",
            "transactionPrice": 655.81,
        }]
        inserted = store.upsert_transactions("TSLA", rows)
        assert len(inserted) == 1
        again = store.upsert_transactions("TSLA", rows)
        assert again == []
        listed = store.list_transactions(symbol="TSLA", days=90)
        assert len(listed) == 1
        assert listed[0]["name"] == "Jane Doe"


def test_insider_transactions_service(monkeypatch):
    async def run():
        from control_plane.news_service import NewsService
        from control_plane.news_store import NewsStore

        with tempfile.TemporaryDirectory() as tmp:
            service = NewsService(store=NewsStore(db_path=os.path.join(tmp, "news.db")))

            async def fake_get_object(path, params):
                assert path == "/stock/insider-transactions"
                assert params["symbol"] == "AAPL"
                return {
                    "symbol": "AAPL",
                    "data": [{
                        "name": "Tim Cook",
                        "share": 1000,
                        "change": 100,
                        "filingDate": "2026-01-10",
                        "transactionDate": "2026-01-08",
                        "transactionCode": "P",
                        "transactionPrice": 180.5,
                    }],
                }

            monkeypatch.setattr("control_plane.news_service._finnhub_get_object", fake_get_object)
            payload = await service.insider_transactions("AAPL")
            assert payload["data"][0]["transactionCode"] == "P"

    asyncio.run(run())
