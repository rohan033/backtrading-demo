from brokers.etoro.candles import (
    compute_candle_fetch_count,
    compute_desc_fetch_count_for_window,
    extract_etoro_candles,
    normalize_etoro_candle,
    select_candles_before,
    select_candles_in_window,
)


def test_normalize_etoro_candle_from_iso_date():
    candle = normalize_etoro_candle({
        "fromDate": "2026-06-09T10:15:00Z",
        "open": 100.1,
        "high": 101.2,
        "low": 99.8,
        "close": 100.9,
        "volume": 42,
    })

    assert candle is not None
    assert candle["open"] == 100.1
    assert candle["close"] == 100.9
    assert candle["volume"] == 42
    assert candle["time"] % 60 == 0


def test_extract_etoro_candles_deduplicates_by_time():
    response = {
        "candles": [
            {"fromDate": "2026-06-09T10:15:00Z", "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 1},
            {"fromDate": "2026-06-09T10:16:00Z", "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.2, "volume": 2},
        ]
    }

    candles = extract_etoro_candles(response)
    assert len(candles) == 2
    assert candles[0]["time"] < candles[1]["time"]


def test_extract_etoro_candles_flattens_nested_instrument_groups():
    response = {
        "interval": "OneMinute",
        "candles": [
            {
                "instrumentId": 100000,
                "candles": [
                    {"fromDate": "2026-06-09T22:21:00Z", "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 12},
                    {"fromDate": "2026-06-09T22:22:00Z", "open": 100.5, "high": 102, "low": 100, "close": 101, "volume": 24},
                ],
                "volume": 36,
            }
        ],
    }

    candles = extract_etoro_candles(response)
    assert len(candles) == 2
    assert candles[0]["volume"] == 12
    assert candles[1]["volume"] == 24


def test_select_candles_before_returns_older_window():
    candles = [
        {"time": 100, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": 160, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 2},
        {"time": 220, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 3},
        {"time": 280, "open": 4, "high": 4, "low": 4, "close": 4, "volume": 4},
    ]

    older = select_candles_before(candles, before_time=220, minutes=2)

    assert [item["time"] for item in older] == [100, 160]


def test_select_candles_in_window_caps_at_max_count():
    candles = [
        {"time": 100, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": 160, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 2},
        {"time": 220, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 3},
    ]

    window = select_candles_in_window(
        candles,
        start_time=100,
        end_time=280,
        max_count=2,
    )

    assert [item["time"] for item in window] == [160, 220]


def test_compute_candle_fetch_count_covers_gap_and_window():
    now = 1_000_000
    before = 1_000_000 - (100 * 60)
    count = compute_candle_fetch_count(before_time=before, minutes=120, now=now)

    assert count == min(100 + 120 + 10, 1000)


def test_compute_desc_fetch_count_for_window():
    now = 1_000_000
    end = 1_000_000 - (100 * 60)
    start = end - (100 * 60)
    count = compute_desc_fetch_count_for_window(start_time=start, end_time=end, now=now)

    assert count == min(100 + 100 + 10, 1000)
