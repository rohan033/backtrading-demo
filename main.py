import imp
from os import symlink
import time
from tabulate import tabulate

from strategy import Strategy
from backtesting import Backtesting
from client import Client
from config import API_KEY, CLIENT_ID, PASSWORD


def backtest(client, token, symbol):
    data = client.get_historical_data(
        token, "2022-05-16 09:15", "2022-05-16 15:15", "ONE_MINUTE"
    )

    if data:
        closing_data = client.get_historical_data(
            token, "2022-05-13 15:29", "2022-05-13 15:30", "ONE_MINUTE"
        )

        if closing_data:
            closing_tick = closing_data[0]

        strategy = Strategy(
            last_tick=closing_tick,
            long_percent=0.5,
            short_percent=10,
        )

        print(strategy)

        funds = 110000
        model = Backtesting(token, data, strategy, funds, symbol=symbol)
        model.run()
        model.print_orders()
        print("===================================================================")


def backtest_on_portfolio(client):
    p = client.portfolio()
    for pp in p:
        token = pp["symboltoken"]
        symbol = pp["tradingsymbol"]
        backtest(client, token, symbol)
        time.sleep(2)


client = Client(API_KEY, CLIENT_ID, PASSWORD)
client.generate_session()
backtest_on_portfolio(client)
