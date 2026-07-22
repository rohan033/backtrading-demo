import os
import tempfile
from datetime import date, timedelta

from control_plane.trade_halts_service import parse_trade_halts_rss
from control_plane.trade_halts_store import TradeHaltsStore, halt_status


SAMPLE_RSS = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">
  <channel>
    <title>NASDAQTrader.com</title>
    <item>
      <title>XPON</title>
      <pubDate>Mon, 20 Jul 2026 04:00:00 GMT</pubDate>
      <ndaq:HaltDate>07/20/2026</ndaq:HaltDate>
      <ndaq:HaltTime>19:50:00.000</ndaq:HaltTime>
      <ndaq:IssueSymbol>XPON</ndaq:IssueSymbol>
      <ndaq:IssueName>Expion360 Inc. CMN STK</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>T3</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice />
      <ndaq:ResumptionDate>07/21/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>08:55:00</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>09:00:00</ndaq:ResumptionTradeTime>
    </item>
    <item>
      <title>CCRN</title>
      <pubDate>Mon, 20 Jul 2026 04:00:00 GMT</pubDate>
      <ndaq:HaltDate>07/20/2026</ndaq:HaltDate>
      <ndaq:HaltTime>19:50:00.000</ndaq:HaltTime>
      <ndaq:IssueSymbol>CCRN</ndaq:IssueSymbol>
      <ndaq:IssueName>Cross Country Healthcare Inc</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>T12</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice />
      <ndaq:ResumptionDate />
      <ndaq:ResumptionQuoteTime />
      <ndaq:ResumptionTradeTime />
    </item>
  </channel>
</rss>
"""


def test_parse_trade_halts_rss():
    entries = parse_trade_halts_rss(SAMPLE_RSS)
    assert len(entries) == 2
    assert entries[0]["symbol"] == "XPON"
    assert entries[0]["reason_code"] == "T3"
    assert entries[0]["resumption_trade_time"] == "09:00:00"
    assert entries[1]["symbol"] == "CCRN"
    assert entries[1]["resumption_date"] is None


def test_halt_status():
    assert halt_status(None, None) == "halted"
    assert halt_status("07/21/2026", None) == "resumed"
    assert halt_status(None, "09:00:00") == "resumed"


def test_upsert_creates_halted_and_resumed_notifications():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradeHaltsStore(db_path=os.path.join(tmp, "halts.db"))
        halted = {
            "symbol": "CCRN",
            "issue_name": "Cross Country",
            "market": "NASDAQ",
            "reason_code": "T12",
            "halt_date": "07/20/2026",
            "halt_time": "19:50:00.000",
        }
        first = store.upsert_halts([halted])
        assert len(first) == 1
        assert first[0]["event_type"] == "halted"
        assert first[0]["symbol"] == "CCRN"

        # Same payload again → no duplicate notification
        assert store.upsert_halts([halted]) == []

        resumed = {
            **halted,
            "resumption_date": "07/21/2026",
            "resumption_trade_time": "09:00:00",
        }
        second = store.upsert_halts([resumed])
        assert len(second) == 1
        assert second[0]["event_type"] == "resumed"

        day_rows = store.list_halts_for_day("2026-07-20")
        assert len(day_rows) == 1
        assert day_rows[0]["status"] == "resumed"
        assert len(store.active_notifications()) == 2

        already_resumed = store.upsert_halts(
            [
                {
                    "symbol": "XPON",
                    "halt_date": "07/20/2026",
                    "halt_time": "19:50:00.000",
                    "reason_code": "T3",
                    "resumption_date": "07/21/2026",
                    "resumption_trade_time": "09:00:00",
                }
            ]
        )
        assert len(already_resumed) == 1
        assert already_resumed[0]["event_type"] == "resumed"


def test_dismiss_and_purge_older():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradeHaltsStore(db_path=os.path.join(tmp, "halts.db"))
        today = date.today()
        old_day = today - timedelta(days=2)
        old_us = old_day.strftime("%m/%d/%Y")
        today_us = today.strftime("%m/%d/%Y")

        store.upsert_halts(
            [
                {
                    "symbol": "OLD",
                    "halt_date": old_us,
                    "halt_time": "10:00:00",
                    "reason_code": "T1",
                },
                {
                    "symbol": "NEW",
                    "halt_date": today_us,
                    "halt_time": "11:00:00",
                    "reason_code": "T2",
                },
            ]
        )
        notes = store.active_notifications()
        assert len(notes) == 2
        assert store.dismiss_notification(notes[0]["id"]) is True
        assert len(store.active_notifications()) == 1

        # Poller keeps today + yesterday; purge anything older than yesterday.
        keep_from = (today - timedelta(days=1)).isoformat()
        purged = store.purge_older_than(keep_from)
        assert purged["halts_deleted"] == 1
        assert store.list_halts_for_day(today.isoformat())[0]["symbol"] == "NEW"
        assert store.list_halts_for_day(old_day.isoformat()) == []
        assert any(row["symbol"] == "NEW" for row in store.list_recent_halts(days=2))


def test_notify_pref_mutes_new_notifications():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradeHaltsStore(db_path=os.path.join(tmp, "halts.db"))
        store.set_notify_enabled("MUTE", False)
        notes = store.upsert_halts(
            [
                {
                    "symbol": "MUTE",
                    "halt_date": "07/20/2026",
                    "halt_time": "10:00:00",
                    "reason_code": "T1",
                },
                {
                    "symbol": "LOUD",
                    "halt_date": "07/20/2026",
                    "halt_time": "11:00:00",
                    "reason_code": "T2",
                },
            ]
        )
        assert [n["symbol"] for n in notes] == ["LOUD"]
        rows = store.list_all_halts()
        by_symbol = {row["symbol"]: row for row in rows}
        assert by_symbol["MUTE"]["notify_enabled"] is False
        assert by_symbol["LOUD"]["notify_enabled"] is True

        store.set_notify_enabled("MUTE", True)
        again = store.upsert_halts(
            [
                {
                    "symbol": "MUTE",
                    "halt_date": "07/20/2026",
                    "halt_time": "10:00:00",
                    "reason_code": "T1",
                    "resumption_date": "07/21/2026",
                    "resumption_trade_time": "09:00:00",
                }
            ]
        )
        assert len(again) == 1
        assert again[0]["event_type"] == "resumed"


def test_purge_missing_ids_keeps_feed_snapshot():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradeHaltsStore(db_path=os.path.join(tmp, "halts.db"))
        store.upsert_halts(
            [
                {"symbol": "KEEP", "halt_date": "07/20/2026", "halt_time": "10:00:00"},
                {"symbol": "DROP", "halt_date": "07/20/2026", "halt_time": "11:00:00"},
            ]
        )
        purged = store.purge_missing_ids({"KEEP|07/20/2026|10:00:00"})
        assert purged["halts_deleted"] == 1
        assert [row["symbol"] for row in store.list_all_halts()] == ["KEEP"]


def test_global_notifications_disable_blocks_all():
    with tempfile.TemporaryDirectory() as tmp:
        store = TradeHaltsStore(db_path=os.path.join(tmp, "halts.db"))
        first = store.upsert_halts(
            [{"symbol": "AAA", "halt_date": "07/20/2026", "halt_time": "10:00:00"}]
        )
        assert len(first) == 1
        assert store.get_global_notifications_enabled() is True

        store.set_global_notifications_enabled(False)
        assert store.get_global_notifications_enabled() is False
        assert store.active_notifications() == []

        again = store.upsert_halts(
            [{"symbol": "BBB", "halt_date": "07/20/2026", "halt_time": "11:00:00"}]
        )
        assert again == []
        assert len(store.list_all_halts()) == 2

        store.set_global_notifications_enabled(True)
        resumed = store.upsert_halts(
            [
                {
                    "symbol": "BBB",
                    "halt_date": "07/20/2026",
                    "halt_time": "11:00:00",
                    "resumption_date": "07/21/2026",
                    "resumption_trade_time": "09:00:00",
                }
            ]
        )
        assert len(resumed) == 1
        assert resumed[0]["event_type"] == "resumed"


def test_hot_symbols_ranks_ludp_repeats():
    rows = [
        {"symbol": "AAA", "reason_code": "LUDP", "status": "halted", "halt_day": "2026-07-21"},
        {"symbol": "AAA", "reason_code": "LUDP", "status": "resumed", "halt_day": "2026-07-21"},
        {"symbol": "AAA", "reason_code": "LUDP", "status": "halted", "halt_day": "2026-07-20"},
        {"symbol": "BBB", "reason_code": "LUDP", "status": "halted", "halt_day": "2026-07-21"},
        {"symbol": "CCC", "reason_code": "T12", "status": "halted", "halt_day": "2026-07-21"},
        {"symbol": "CCC", "reason_code": "T12", "status": "halted", "halt_day": "2026-07-20"},
    ]
    hot = TradeHaltsStore.hot_symbols(rows, reason_code="LUDP", limit=6)
    assert [item["symbol"] for item in hot] == ["AAA", "BBB"]
    assert hot[0]["halt_count"] == 3
    assert hot[1]["halt_count"] == 1

