from tabulate import tabulate

from order import Order


class Backtesting:
    def __init__(self, token, data, strategy, funds, base_funds=100000, symbol=None):
        self.data = data
        self.token = token
        self.strategy = strategy
        self._orders = []
        self.funds = funds
        self.base_funds = base_funds
        self._total_shares = 0
        self.symbol = symbol

    def _can_buy(self, data):
        return self.funds >= self.base_funds and self.funds >= data.close

    def _buy(self, data):
        self._total_shares = int(self.funds / data.close)
        amount = self._total_shares * data.close
        self.funds -= amount
        self._orders.append(
            Order(
                amount,
                data.close,
                self._total_shares,
                "BUY",
                self.token,
                self.symbol,
                data.time,
            )
        )

    def _sell(self, data):
        amount = self._total_shares * data.close
        self.funds += amount
        self._orders.append(
            Order(
                amount,
                data.close,
                self._total_shares,
                "SELL",
                self.token,
                self.symbol,
                data.time,
            )
        )
        self._total_shares = 0

    def show_status(self):
        print(f"Funds: {self.funds}")
        print(f"Shares: {self._total_shares}")
        print(f"Last Order: {self._orders[-1]}")

    def run(self):
        for d in self.data:
            transaction = False
            # print(d.close)
            if self._can_buy(d) and self.strategy.should_buy(d):
                self._buy(d)
                # print("buying")
                transaction = True
            elif self.strategy.should_sell(d):
                self._sell(d)
                # print("selling")
                transaction = True

            if transaction:
                # print("updating strategy")
                self.strategy.update_last_tick(d)
                # self.show_status()

    def pnl(self):
        amount = 0
        for order in self._orders:
            if order.order_type == "BUY":
                amount -= order.amount
            else:
                amount += order.amount

        return amount

    def print_orders(self):
        headers = [
            "unit_price",
            "quantity",
            "order_type",
            "token",
            "symbol",
            "time",
            "pnl",
            "net",
        ]
        net = 0
        orders = []
        last_order = None
        for order in self._orders:
            pnl = 0
            if order.order_type == "SELL" and last_order:
                pnl = (order.unit_price * order.quantity) - (
                    last_order.unit_price * last_order.quantity
                )
                net += pnl
                net_amt = net
            else:
                net_amt = 0
            last_order = order
            o = [
                order.unit_price,
                order.quantity,
                order.order_type,
                order.token,
                order.symbol,
                order.time,
                pnl,
                net_amt,
            ]
            orders.append(o)

        print(tabulate(orders, headers=headers, tablefmt="fancy_grid"))
