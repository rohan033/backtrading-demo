from managers.candle_store import CandleStore, minute_bucket


def test_apply_tick_updates_forming_candle():
    store = CandleStore()
    bucket = minute_bucket(1_700_000_000.0)

    first = store.apply_tick(100.0, ts=1_700_000_010.0)
    second = store.apply_tick(105.0, ts=1_700_000_020.0)

    assert first["time"] == bucket
    assert second["time"] == bucket
    assert second["open"] == 100.0
    assert second["high"] == 105.0
    assert second["low"] == 100.0
    assert second["close"] == 105.0


def test_apply_tick_starts_new_minute_bar():
    store = CandleStore()
    first_bucket = minute_bucket(1_700_000_010.0)
    second_bucket = minute_bucket(1_700_000_070.0)

    store.apply_tick(100.0, ts=1_700_000_010.0)
    next_bar = store.apply_tick(99.0, ts=1_700_000_070.0)

    bars = store.bars()
    assert len(bars) == 2
    assert bars[0]["time"] == first_bucket
    assert bars[0]["close"] == 100.0
    assert next_bar["time"] == second_bucket
    assert next_bar["open"] == 100.0
    assert next_bar["close"] == 99.0


def test_apply_sync_reconciles_completed_bars():
    store = CandleStore()
    store.bootstrap([
        {"time": 100, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 10},
    ])
    store.apply_tick(1.6, ts=160.0)

    store.apply_sync([
        {"time": 100, "open": 1, "high": 2.5, "low": 0.9, "close": 2.1, "volume": 12},
    ])

    bars = store.bars()
    assert bars[0]["high"] == 2.5
    assert bars[0]["close"] == 2.1


def test_prepend_older_adds_completed_bars_before_forming():
    store = CandleStore()
    store.bootstrap([
        {"time": 1_700_000_100, "open": 10, "high": 11, "low": 9, "close": 10.5, "volume": 1},
        {"time": 1_700_000_160, "open": 10.5, "high": 11.5, "low": 10, "close": 11, "volume": 2},
    ])
    store.apply_tick(11.2, ts=1_700_000_220.0)

    added = store.prepend_older([
        {"time": 1_700_000_040, "open": 8, "high": 9, "low": 7.5, "close": 8.5, "volume": 3},
        {"time": 1_700_000_160, "open": 10.5, "high": 11.5, "low": 10, "close": 11, "volume": 2},
    ])

    assert added == 1
    assert store.oldest_time() == 1_700_000_040
    assert len(store.bars()) == 4
