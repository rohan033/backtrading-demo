import os

from dotenv import load_dotenv
load_dotenv()

API_KEY = os.getenv("ANGEL_API_KEY", "")
CLIENT_ID = os.getenv("ANGEL_CLIENT_ID", "")
PASSWORD = os.getenv("ANGEL_PASSWORD", "")

MPIN = os.getenv("ANGEL_MPIN", "")
TOTP_KEY = os.getenv("ANGEL_TOTP_KEY", "")
API_KEY = os.getenv("API_KEY")
CLIENT_ID = os.getenv("CLIENT_ID")



POSITION_STATE_MACHINE = {
    "open": "close_requested",
    "close_requested": "closed"
}

ORDER_DETAIL_STATE_MACHINE =    {
    "open_requested": ["opened", "cancel_requested"],
    "opened": ["filled", "cancel_requested"],
    "cancel_requested": ["cancelled"]
}