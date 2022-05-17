class OrderService:
    def __init__(self, client, trading_context) -> None:
        self.client = client
        self.trading_context = trading_context

    def place_order(self, order):
        order_detail = self.client.place_order(order)
        if order_detail:
            self.trading_context.update_order_info(order_detail)

        return order_detail

    def exit_order(self, order_id, order):
        if self._can_exit_order(order_id, order):
            order_detail = self.client.place_order(order)
            if order_detail:
                self.trading_context.update_order_info(order)
            return order_detail

        return None

        pass
