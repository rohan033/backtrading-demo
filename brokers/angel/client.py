from SmartApi import SmartConnect #or from SmartApi.smartConnect import SmartConnect
import pyotp
from logzero import logger
import os

class AngelClient():
    def __init__(self):
        self.name = "Angel"
        self.api_key = os.getenv("ANGEL_API_KEY")
        self.userid = os.getenv("ANGEL_USER_ID")
        self.mpin = os.getenv("ANGEL_MPIN")
        self.totp_key = os.getenv("ANGEL_TOTP_KEY")
        self._client = SmartConnect(self.api_key)

    def generate_session(self):
        try:
            totp = pyotp.TOTP(self.totp_key).now()
        except Exception as e:
            logger.error("Invalid Token: The provided token is not valid.")
            raise e

        session = self._client.generateSession(self.userid, self.mpin, totp)

        if session['status'] == False:
            logger.error(session)
            raise Exception("Session generation failed")
        else:
            refreshToken = session['data']['refreshToken']
            self._client.generateToken(refreshToken)
            if session['status'] == False:
                logger.error("Token generation failed")
                raise Exception("Token generation failed")
            logger.info("Session generated successfully")
            return session
   



    