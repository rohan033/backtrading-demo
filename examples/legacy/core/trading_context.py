class TradingContext:
    def __init__(self, order_details={}, positions={}, trades={}, position_mapping={}) -> None:
        self.order_details = order_details # placed orders
        self.positions = positions # executed orders
        self.trades = trades # each executed order is a trades

    def update_order_info(self, order_detail):
        if order_detail.order_id in self.order_details:
            existing_order_detail = self.order_details[order_detail.order_id]
            existing_order_detail.history.append("state transition history")
            existing_order_detail.status = order_detail.status
            self.order_details[order_detail.order_id] = existing_order_detail
        else:
            self.order_details[order_detail.order_id] = order_detail

    
    def update_order_position(self, order_detail):
        # if there is any position for the order_id
        if order_detail.id in self.positions:
            pass
