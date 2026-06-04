import unittest

from indicators.core import bollinger_bands, rsi
from indicators.streaming import StreamingIndicators
from strategies.rsi_bollinger_strategy import RsiBollingerStrategy
from strategy_config import StrategyConfig
from brokers.interfaces import TickData


class TestRsi(unittest.TestCase):
    def test_rsi_insufficient_data(self):
        self.assertIsNone(rsi([100.0] * 10, 14))

    def test_rsi_all_gains(self):
        prices = [float(i) for i in range(1, 20)]
        value = rsi(prices, period=14)
        self.assertIsNotNone(value)
        self.assertGreater(value, 90.0)

    def test_rsi_all_losses(self):
        prices = [float(20 - i) for i in range(20)]
        value = rsi(prices, period=14)
        self.assertIsNotNone(value)
        self.assertLess(value, 10.0)


class TestBollinger(unittest.TestCase):
    def test_bollinger_symmetric_window(self):
        prices = [100.0] * 20
        bands = bollinger_bands(prices, period=20, num_std=2.0)
        self.assertIsNotNone(bands)
        middle, upper, lower = bands
        self.assertEqual(middle, 100.0)
        self.assertEqual(upper, 100.0)
        self.assertEqual(lower, 100.0)


class TestStreaming(unittest.TestCase):
    def test_warmup_then_ready(self):
        stream = StreamingIndicators(rsi_period=3, bb_period=5, bb_std=2.0)
        for i in range(6):
            snap = stream.update(100.0 + i)
        self.assertTrue(snap.ready)
        self.assertIsNotNone(snap.rsi)
        self.assertIsNotNone(snap.bb_lower)


class TestRsiBollingerStrategy(unittest.TestCase):
    def test_buy_when_oversold_and_below_lower_band(self):
        cfg = StrategyConfig(
            strategy_type="rsi-bollinger",
            symbol="TEST",
            token="1",
            rsi_period=3,
            bb_period=5,
            rsi_oversold=50.0,
            max_available_capital=10000,
        )
        strat = RsiBollingerStrategy(cfg)
        strat.initialize_with_close_price(100.0)

        declining = [100.0, 99.0, 98.0, 97.0, 96.0, 95.0, 94.0, 93.0]
        signal = None
        for p in declining:
            signal = strat.provide_signal(
                TickData(symbol="TEST", token="1", ltp=p, exchange="NSE"),
                available_capital=10000,
            )

        self.assertIsNotNone(signal)
        self.assertIn(signal.decision, ("BUY", "NOTHING"))


if __name__ == "__main__":
    unittest.main()
