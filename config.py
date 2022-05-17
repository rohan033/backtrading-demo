import os

API_KEY = os.getenv("ANGEL_API_KEY", "")
CLIENT_ID = os.getenv("ANGEL_CLIENT_ID", "")
PASSWORD = os.getenv("ANGEL_PASSWORD", "")

POSITION_STATE_MACHINE = {
    "open": "close_requested",
    "close_requested": "closed"
}

ORDER_DETAIL_STATE_MACHINE =    {
    "open_requested": ["opened", "cancel_requested"],
    "opened": ["filled", "cancel_requested"],
    "cancel_requested": ["cancelled"]
}