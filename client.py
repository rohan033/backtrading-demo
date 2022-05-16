from smartapi import SmartConnect

from utils import build_tick
from utils import print_portfolio


class Client:
    def __init__(self, api_key, userid, password):
        self.api_key = api_key
        self.userid = userid
        self.password = password
        self._client = SmartConnect(api_key)

    def generate_session(self):
        self._client.generateSession(self.userid, self.password)

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
        return res

    def print_portfolio(self):
        portfolio = self.portfolio()
        print_portfolio(portfolio)
