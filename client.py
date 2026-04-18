from SmartApi import SmartConnect #or from SmartApi.smartConnect import SmartConnect
import pyotp
from logzero import logger
import os


from utils import build_tick
from utils import print_portfolio, required_empty
from pprint import pprint


class Client:
    # def __init__(self, api_key, userid, password=None):
    #     required = [api_key, userid]
    #     # if required_empty(required):
    #     #     raise Exception("Please provide all the required client arguments")

    #     self.api_key = api_key
    #     self.userid = userid
    #     self.password = password
    #     self._client = SmartConnect(api_key)

    # def generate_session(self):
    #     self._client.generateSession(self.userid, self.password)

    def get_historical_data(self, token, start_time, end_time, interval):
        payload = dict(
            exchange="NSE",
            symboltoken=token,
            interval=interval,
            fromdate=start_time,
            todate=end_time,
        )
        res = self._client.getCandleData(payload)
        historical_data = res["data"]
        return self._convert(historical_data, token)

    def _convert(self, historical_data, token):
        res = []
        if historical_data:
            for data in historical_data:
                # print(data)
                res.append(build_tick(data, token))
        return res

    def portfolio(self):
        res = self._client.holding()["data"]
        pprint(res)
        return res

    def print_portfolio(self):
        portfolio = self.portfolio()
        print_portfolio(portfolio)


class TotpClient():
    def __init__(self, api_key, userid, mpin, totp_key):
        self.api_key = api_key
        self.userid = userid
        self.password = mpin
        self.totp_key = totp_key
        self._client = SmartConnect(api_key)

    def generate_session(self):
        try:
            totp = pyotp.TOTP(self.totp_key).now()
        except Exception as e:
            logger.error("Invalid Token: The provided token is not valid.")
            raise e

        correlation_id = "abcde"
        data = self._client.generateSession(self.userid, self.password, totp)

        if data['status'] == False:
            logger.error(data)
            raise Exception("Session generation failed")
        else:
            authToken = data['data']['jwtToken']
            refreshToken = data['data']['refreshToken']
            feedToken = self._client.getfeedToken()
            res = self._client.getProfile(refreshToken)
            self._client.generateToken(refreshToken)
            logger.info("Session generated successfully")
            return data
    
    def get_historical_data(self, token, start_time, end_time, interval):
        payload = dict(
            exchange="NSE",
            symboltoken=token,
            interval=interval,
            fromdate=start_time,
            todate=end_time,
        )
        res = self._client.getCandleData(payload)
        historical_data = res["data"]
        return self._convert(historical_data, token)

    def _convert(self, historical_data, token):
        res = []
        if historical_data:
            for data in historical_data:
                # print(data)
                res.append(build_tick(data, token))
        return res

    def portfolio(self):
        res = self._client.holding()["data"]
        pprint(res)
        return res

    def print_portfolio(self):
        portfolio = self.portfolio()
        print_portfolio(portfolio)
