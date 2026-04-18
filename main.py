import time

from strategy import Strategy
from backtesting import Backtesting


def backtest(client, token, symbol):
    data = client.get_historical_data(
        token, "2026-04-17 09:15", "2026-04-17 15:15", "ONE_MINUTE"
    )

    if data:
        closing_data = client.get_historical_data(
            token, "2026-04-16 15:29", "2026-04-16 15:30", "ONE_MINUTE"
        )
        print("Closing data:")
        print(closing_data)
        exit()

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
    pp = p[0]
    token = pp["symboltoken"]
    symbol = pp["tradingsymbol"]
    backtest(client, token, symbol)
    time.sleep(2)

# from client import Client
# from config import API_KEY, CLIENT_ID, PASSWORD
# client = Client(API_KEY, CLIENT_ID, PASSWORD)
# client.generate_session()

from client import TotpClient
from dotenv import load_dotenv
import os

load_dotenv()

API_KEY = os.getenv("API_KEY")
CLIENT_ID = os.getenv("CLIENT_ID")
MPIN = os.getenv("MPIN")
TOTP_KEY = os.getenv("TOTP_KEY")
totp_client = TotpClient(API_KEY, CLIENT_ID, MPIN, TOTP_KEY)
totp_client.generate_session()

totp_client.print_portfolio()

backtest_on_portfolio(totp_client)


