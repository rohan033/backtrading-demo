from brokers.angel.client import AngelClient
from brokers.interfaces import TickClient, Subscription, LTPData
from logzero import logger

class AngelOneTradingClient(AngelClient, TickClient):
    def __init__(self):
        super().__init__()

    async def aget_ltp_bulk(self, subscriptions: list[Subscription]) -> list[LTPData]:
        exchange_tokens = {}
        for subscription in subscriptions:
            exchange = subscription.exchange
            token_id = subscription.token
            if exchange not in exchange_tokens:
                exchange_tokens[exchange] = []
            exchange_tokens[exchange].append(token_id)

        ltps = await self.aget_market_data("LTP", exchange_tokens)
        if ltps:
            return [LTPData(exchange=symbol_token["exchange"], symbol=symbol_token["tradingSymbol"], token=symbol_token["symbolToken"], ltp=symbol_token["ltp"]) for symbol_token in ltps["fetched"]]
        return []

    async def aget_market_data(self, mode, exchange_tokens):
        try:
            res = await self._client.getMarketData(mode, exchange_tokens)
            if res and res.get("status") and res.get("data"):
                return res["data"]
        except Exception as e:
            logger.error("getMarketData error: %s", e)
        return None

    async def aget_ltp(self, exchange, symbol, token):
        try:
            res = await self._client.ltpData(exchange, symbol, token)
            if res and res.get("data"):
                return float(res["data"]["ltp"])
        except Exception as e:
            logger.error("ltpData error: %s", e)
        return None
    
    async def abuy(self,
            ltp,
            available_capital,
            symbol,
            token,
            exchange,
            variety = "NORMAL",
            orderType = "LIMIT",
            productType = "DELIVERY",
            duration = "DAY"):
        quantity = int(available_capital / ltp)
        if quantity < 1:
            logger.warning("Capital %.2f too low for LTP=%.2f", available_capital, ltp)
            return
        logger.info("Calculated qty=%d (capital=%.0f / ltp=%.2f)", quantity, available_capital, ltp)

        buy_params = {
            "tradingsymbol": symbol,
            "symboltoken": token,
            "exchange": exchange,
            "transactiontype": "BUY",
            "ordertype": orderType,
            "quantity": str(quantity),
            "producttype": productType,
            "price": str(ltp),
            "duration": duration,
            "variety": variety
        }

        try:
            res = await self._client.placeOrderFullResponse(buy_params)
            if res and res.get("status"):
                data = res.get("data", {})
                order_id = data.get("orderid")
                unique_order_id = data.get("uniqueorderid")
                return {
                    "order_id": order_id,
                    "unique_order_id": unique_order_id
                }
            else:
                logger.error("Entry order FAILED: %s", res)
                return {}
        except Exception as e:
            logger.error("Exception placing entry order: %s", e)
            return {}
