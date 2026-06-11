from brokers.etoro.feed_config import (
    etoro_uses_websocket_feed,
    normalize_etoro_feed_mode,
    normalize_feed_tick_sample_every,
)


def test_normalize_etoro_feed_mode_defaults_to_websocket():
    assert normalize_etoro_feed_mode(None) == "websocket"
    assert normalize_etoro_feed_mode("polling") == "rest"


def test_etoro_uses_websocket_feed():
    assert etoro_uses_websocket_feed("websocket") is True
    assert etoro_uses_websocket_feed("rest") is False


def test_normalize_feed_tick_sample_every_zero_means_forward_all():
    assert normalize_feed_tick_sample_every(0) == 0
    assert normalize_feed_tick_sample_every(None) == 0
    assert normalize_feed_tick_sample_every(5) == 5
