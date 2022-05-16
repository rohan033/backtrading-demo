from tabulate import tabulate

from utils import round_off


class Strategy:
    def __init__(
        self,
        last_tick,
        initial=True,
        long_position=True,
        long_percent=0.5,
        short_percent=0.1,
        initial_threshold=0.1,
    ):
        self.long_position = long_position
        self.last_tick = last_tick
        self.long_percent = long_percent
        self.short_percent = short_percent
        self.initial_threshold = initial_threshold
        self.initial = initial

    def __repr__(self) -> str:
        headers = [
            "last_price",
            "long_percent",
            "short_percent",
            "initial_threshold",
        ]
        data = [
            self.last_tick.close,
            self.long_percent,
            self.short_percent,
            self.initial_threshold,
        ]
        return tabulate([data], headers=headers, tablefmt="grid")

    def update_last_tick(self, tick):
        self.last_tick = tick

    def should_buy(self, data):
        if self.long_position:
            change_percentage = (
                round_off((data.close - self.last_tick.close) / self.last_tick.close)
            ) * 100
            has_crossed_threshold = False

            if change_percentage >= self.initial_threshold:
                has_crossed_threshold = True

            if has_crossed_threshold:
                self.long_position = False

            return has_crossed_threshold

    def should_sell(self, data):
        if not self.long_position:
            change_percentage = (
                round_off((data.close - self.last_tick.close) / self.last_tick.close)
            ) * 100
            has_crossed_threshold = False

            threshold = None
            if change_percentage >= 0:
                has_crossed_threshold = change_percentage >= self.long_percent
                threshold = self.long_percent
            else:
                has_crossed_threshold = abs(change_percentage) >= self.short_percent
                threshold = self.short_percent

            if has_crossed_threshold:
                self.long_position = True

            return has_crossed_threshold
