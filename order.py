class Order:
    def __init__(
        self, amount, unit_price, quantity, order_type, token, symbol, time=None
    ):
        self.amount = amount
        self.unit_price = unit_price
        self.quantity = quantity
        self.order_type = order_type
        self.token = token
        self.symbol = symbol
        self.time = time

    def __repr__(self):
        return f"Order(amount={self.amount}, unit_price={self.unit_price}, quantity={self.quantity}, order_type={self.order_type}, token={self.token}, symbol={self.symbol}, time={self.time})"
