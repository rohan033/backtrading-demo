import os
import tempfile

from control_plane.news_store import NewsStore


def _item(item_id: int, headline: str):
    return {
        "id": item_id,
        "headline": headline,
        "datetime": 1_700_000_000 + item_id,
        "source": "Finnhub",
        "url": f"https://example.test/{item_id}",
    }


def test_news_cache_round_trips_compressed_payload():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "news.db")
        store = NewsStore(db_path=path)

        stored = store.set_cache(
            cache_key="company:AAPL:30",
            scope="company",
            topic="AAPL",
            days=30,
            items=[_item(1, "Apple headline")],
            fetched_at=123.0,
        )

        assert stored.item_ids == {1}
        loaded = store.get_cache("company:AAPL:30")
        assert loaded is not None
        assert loaded.items[0]["headline"] == "Apple headline"
        assert loaded.fetched_at == 123.0


def test_news_notifications_are_deduped_by_scope_topic_and_item():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "news.db")
        store = NewsStore(db_path=path)

        first = store.insert_notifications(
            scope="company",
            topic="AAPL",
            items=[_item(1, "First")],
            existing_item_ids=set(),
        )
        duplicate = store.insert_notifications(
            scope="company",
            topic="AAPL",
            items=[_item(1, "First")],
            existing_item_ids=set(),
        )

        assert len(first) == 1
        assert duplicate == []
        assert len(store.recent_notifications()) == 1
