# package import statement
from SmartApi import SmartConnect #or from SmartApi.smartConnect import SmartConnect
import pyotp
from logzero import logger
import os

from dotenv import load_dotenv
load_dotenv()

POSITION_STATE_MACHINE = {
    "open": "close_requested",
    "close_requested": "closed"
}

ORDER_DETAIL_STATE_MACHINE =    {
    "open_requested": ["opened", "cancel_requested"],
    "opened": ["filled", "cancel_requested"],
    "cancel_requested": ["cancelled"]
}

api_key = os.getenv("API_KEY")
username = os.getenv("CLIENT_ID")
smartApi = SmartConnect(api_key)
mpin = os.getenv("MPIN")
try:
    token = os.getenv("TOTP_KEY")
    totp = pyotp.TOTP(token).now()
except Exception as e:
    logger.error("Invalid Token: The provided token is not valid.")
    raise e

correlation_id = "abcde"
data = smartApi.generateSession(username, mpin, totp)


if data['status'] == False:
    logger.error(data)
    
else:
    # login api call
    # logger.info(f"You Credentials: {data}")
    authToken = data['data']['jwtToken']
    refreshToken = data['data']['refreshToken']
    # fetch the feedtoken
    feedToken = smartApi.getfeedToken()
    # fetch User Profile
    res = smartApi.getProfile(refreshToken)
    print("Profile:", res)
    smartApi.generateToken(refreshToken)
    res=res['data']['exchanges']
    print("Exchanges:", res)