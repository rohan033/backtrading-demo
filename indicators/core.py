"""Pure technical indicators over a price series (each point = tick LTP or bar close)."""


def rsi(prices: list[float], period: int = 14) -> float | None:
    """
    Wilder-smoothed RSI. Returns None until at least ``period + 1`` prices exist.
    """
    if period < 1 or len(prices) < period + 1:
        return None

    deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    gains = [max(d, 0.0) for d in deltas[:period]]
    losses = [max(-d, 0.0) for d in deltas[:period]]
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    for d in deltas[period:]:
        gain = max(d, 0.0)
        loss = max(-d, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def bollinger_bands(
    prices: list[float],
    period: int = 20,
    num_std: float = 2.0,
) -> tuple[float, float, float] | None:
    """
    Bollinger Bands: (middle SMA, upper, lower). None until ``period`` prices exist.
    """
    if period < 1 or len(prices) < period:
        return None

    window = prices[-period:]
    middle = sum(window) / period
    variance = sum((p - middle) ** 2 for p in window) / period
    std = variance**0.5
    upper = middle + num_std * std
    lower = middle - num_std * std
    return middle, upper, lower
