class Tick:
    def __init__(self, time, open, high, low, close, volume, token):
        self.time = time
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
        self.token = token

    def __repr__(self):
        return f"Tick(time={self.time}, open={self.open}, high={self.high}, low={self.low}, close={self.close}, volume={self.volume}, token={self.token})"
