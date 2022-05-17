class TradingContext:
    def __init__(self, order_details={}, positions={}, trades={}) -> None:
        self.order_details = order_details
        self.positions = positions
        self.trades = trades

    def update_order_info(self, order_detail):
        if order_detail.type == "BUY":
            self.order_details.update(order_detail.id, order_detail)
