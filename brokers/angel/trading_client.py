import asyncio
from typing import Any

from brokers.angel.client import AngelClient
from brokers.interfaces import TickClient, Subscription, LTPData
from logzero import logger

# Angel rejects that will not succeed on retry — halt entry instead of spamming orders.
PERMANENT_ANGEL_ORDER_ERROR_CODES = frozenset({
    "AB4036",  # cautionary / exchange-restricted listing
})


def parse_angel_order_response(res: dict[str, Any] | None) -> dict[str, Any]:
    if res and res.get("status"):
        data = res.get("data") or {}
        return {
            "order_id": data.get("orderid"),
            "unique_order_id": data.get("uniqueorderid"),
        }

    error_code = str((res or {}).get("errorcode") or "").strip()
    error_message = str((res or {}).get("message") or "Order placement failed").strip()
    return {
        "error_code": error_code or None,
        "error_message": error_message,
        "permanent_failure": error_code in PERMANENT_ANGEL_ORDER_ERROR_CODES,
    }


class AngelOneTradingClient(AngelClient, TickClient):
    def __init__(self):
        super().__init__()

    def is_bo_client(self) -> bool:
        return False

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
            return {"error_message": "Quantity below 1"}
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
            res = await asyncio.to_thread(self._client.placeOrderFullResponse, buy_params)
            parsed = parse_angel_order_response(res)
            if parsed.get("order_id"):
                return parsed
            logger.error("Entry order FAILED: %s", res)
            return parsed
        except Exception as e:
            logger.error("Exception placing entry order: %s", e)
            return {"error_message": str(e)}

    async def asell(self,
            ltp,
            quantity,
            symbol,
            token,
            exchange,
            variety = "NORMAL",
            orderType = "MARKET",
            productType = "DELIVERY",
            duration = "DAY"):
        if quantity <= 0:
            logger.warning("Quantity %s too low for SELL", quantity)
            return {}

        sell_params = {
            "tradingsymbol": symbol,
            "symboltoken": token,
            "exchange": exchange,
            "transactiontype": "SELL",
            "ordertype": orderType,
            "quantity": str(int(quantity)),
            "producttype": productType,
            "duration": duration,
            "variety": variety
        }
        if orderType != "MARKET":
            sell_params["price"] = str(ltp)

        try:
            res = await asyncio.to_thread(self._client.placeOrderFullResponse, sell_params)
            parsed = parse_angel_order_response(res)
            if parsed.get("order_id"):
                return parsed
            logger.error("Exit order FAILED: %s", res)
            return parsed
        except Exception as e:
            logger.error("Exception placing exit order: %s", e)
            return {"error_message": str(e)}
