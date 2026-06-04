from brokers.angel.client import AngelClient

class AngelOneWebSocketClient(AngelClient):
    """Backward-compatible alias; use AngelWebsocketFeedClient for streaming."""

    def __init__(self):
        super().__init__()
