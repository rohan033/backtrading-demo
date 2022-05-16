from tabulate import tabulate

from tick import Tick


def build_tick(data, token):
    return Tick(
        time=data[0],
        open=data[1],
        high=data[2],
        low=data[3],
        close=data[4],
        volume=data[5],
        token=token,
    )


def print_portfolio(portfolio):
    headers = [
        "tradingsymbol",
        "exchange",
        "quantity",
        "ltp",
        "symboltoken",
        "symbol",
        "profitandloss",
    ]

    data = []
    for holding in portfolio:
        data.append(
            [
                holding["tradingsymbol"],
                holding["exchange"],
                holding["quantity"],
                holding["ltp"],
                holding["symboltoken"],
                holding["tradingsymbol"],
                holding["profitandloss"],
            ]
        )
    print(tabulate(data, headers=headers, tablefmt="fancy_grid"))


# method round off decimal till 4 decimal places
def round_off(value):
    return round(value, 4)
