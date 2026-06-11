import asyncio
import json
from typing import Any

from brokers.etoro.client import EtoroClient
from brokers.etoro.order_helpers import apply_v1_bracket_fields, resolve_bracket_stop_loss_rate
from brokers.interfaces import TickClient, Subscription, LTPData
from logzero import logger


class EtoroTradingClient(EtoroClient, TickClient):
    def __init__(self, account_env: str | None = None):
        super().__init__(account_env=account_env)

    def is_bo_client(self) -> bool:
        return False

    async def aget_ltp_bulk(self, subscriptions: list[Subscription]) -> list[LTPData]:
        """Fetch latest prices for multiple symbols from eToro."""
        instrument_map = {}
        for subscription in subscriptions:
            instrument_id = await self._instrument_id(subscription.symbol, subscription.token)
            if instrument_id is None:
                logger.warning("[eToro] Could not resolve instrument for %s/%s", subscription.symbol, subscription.token)
                continue
            instrument_map[instrument_id] = subscription

        results = []
        instrument_ids = list(instrument_map.keys())
        for start in range(0, len(instrument_ids), 100):
            rates = await self.aget_rates(instrument_ids[start:start + 100])
            for rate in rates:
                instrument_id = rate.get("instrumentID") or rate.get("instrumentId")
                subscription = instrument_map.get(instrument_id)
                ltp = self._rate_ltp(rate)
                if subscription and ltp is not None:
                    results.append(
                        LTPData(
                            exchange=subscription.exchange,
                            symbol=subscription.symbol,
                            token=subscription.token,
                            ltp=ltp,
                        )
                    )
        return results

    async def aget_ltp(self, exchange, symbol, token):
        """Fetch the latest price for a single symbol."""
        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            return None

        rates = await self.aget_rates([instrument_id])
        if rates:
            return self._rate_ltp(rates[0])
        return None

    async def abuy(self, ltp, available_capital, symbol, token, exchange,
                   variety="NORMAL", orderType="LIMIT",
                   productType="DELIVERY", duration="DAY"):
        """Place a buy order on eToro."""
        if available_capital <= 0:
            logger.warning("[eToro] Capital %.2f too low for BUY", available_capital)
            return {}

        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            logger.error("[eToro] Cannot place BUY; unresolved instrument: %s/%s", symbol, token)
            return {}

        logger.info("[eToro] Placing BUY: symbol=%s amount=%.2f ref_price=%.2f", symbol, available_capital, ltp)

        payload = {
            "InstrumentID": instrument_id,
            "IsBuy": True,
            "Leverage": self._default_leverage(),
            "Amount": float(available_capital),
        }
        return await self._place_market_open_by_amount(payload, "BUY")

    async def asell(self, ltp, quantity, symbol, token, exchange,
                    variety="NORMAL", orderType="LIMIT",
                    productType="DELIVERY", duration="DAY"):
        """Place a short/sell market order on eToro by units.

        To exit an existing long position, use aclose_position(position_id).
        eToro closes by position ID rather than by symbol.
        """
        if quantity <= 0:
            logger.warning("[eToro] Quantity %.4f too low for SELL", quantity)
            return {}

        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            logger.error("[eToro] Cannot place SELL; unresolved instrument: %s/%s", symbol, token)
            return {}

        logger.info("[eToro] Placing SELL: symbol=%s qty=%.4f price=%.2f", symbol, quantity, ltp)

        payload = {
            "InstrumentID": instrument_id,
            "IsBuy": False,
            "Leverage": self._default_leverage(),
            "AmountInUnits": float(quantity),
        }
        try:
            response = await self.arequest(
                "POST",
                f"{self.execution_base_path()}/market-open-orders/by-units",
                json_body=payload,
                trade_execution=True,
            )
            return self._order_result(response)
        except Exception as e:
            logger.error("[eToro] Exception placing SELL order: %s", e)
            return {}

    async def acancel_order(self, order_id):
        """Cancel an existing order on eToro."""
        logger.info("[eToro] Cancelling order: %s", order_id)

        for path in (
            f"{self.execution_base_path()}/market-open-orders/{order_id}",
            f"{self.execution_base_path()}/market-close-orders/{order_id}",
            f"{self.execution_base_path()}/limit-orders/{order_id}",
        ):
            try:
                await self.arequest("DELETE", path, trade_execution=True)
                return True
            except Exception as e:
                logger.debug("[eToro] Cancel attempt failed for %s: %s", path, e)
        return False

    async def aget_order_status(self, order_id):
        """Get the status of an order on eToro."""
        logger.info("[eToro] Getting order status: %s", order_id)

        try:
            return await self.arequest("GET", f"{self.info_base_path()}/orders/{order_id}")
        except Exception as e:
            logger.error("[eToro] Error getting order status for %s: %s", order_id, e)
            return None

    async def aget_positions(self):
        """Get all open positions on eToro."""
        logger.info("[eToro] Getting open positions")

        try:
            portfolio = await self.aget_client_portfolio()
            return portfolio.get("positions", []) or []
        except Exception as e:
            logger.error("[eToro] Error getting positions: %s", e)
            return []

    async def aget_client_portfolio(self) -> dict[str, Any]:
        """Fetch the full clientPortfolio object from eToro /pnl."""
        response = await self.arequest("GET", f"{self.info_base_path()}/pnl")
        if isinstance(response, dict):
            portfolio = response.get("clientPortfolio")
            if isinstance(portfolio, dict):
                return portfolio
        return {}

    async def aget_available_cash(self) -> float:
        """Return USD cash available to open new positions.

        Per eToro: Available Cash = credit
            - Σ(ordersForOpen[i].amount where mirrorID == 0)
            - Σ(orders[i].amount)
        """
        portfolio = await self.aget_client_portfolio()
        credit = float(portfolio.get("credit") or 0.0)

        pending_open = 0.0
        for order in portfolio.get("ordersForOpen") or []:
            if not isinstance(order, dict):
                continue
            mirror_id = order.get("mirrorID", order.get("mirrorId", 0)) or 0
            if int(mirror_id) != 0:
                continue
            pending_open += float(order.get("amount") or 0.0)

        pending_close = 0.0
        for order in portfolio.get("orders") or []:
            if not isinstance(order, dict):
                continue
            pending_close += float(order.get("amount") or 0.0)

        available = credit - pending_open - pending_close
        logger.info(
            "[eToro] available cash credit=%.2f pending_open=%.2f pending_orders=%.2f -> available=%.2f",
            credit, pending_open, pending_close, available,
        )
        return max(0.0, available)

    async def aget_orders_snapshot(self) -> dict[str, list[dict[str, Any]]]:
        """Return pending/active orders from eToro /pnl."""
        portfolio = await self.aget_client_portfolio()
        return {
            "orders": portfolio.get("orders", []) or [],
            "orders_for_open": portfolio.get("ordersForOpen", []) or [],
            "orders_for_close": portfolio.get("ordersForClose", []) or [],
        }

    async def aclose_position(
        self,
        position_id,
        *,
        units: float | None = None,
        instrument_id: int | None = None,
    ):
        """Close a specific position on eToro.

        When units is omitted or <= 0, eToro closes the full position.
        """
        logger.info("[eToro] close_position START position=%s units=%s", position_id, units)

        resolved_instrument_id = instrument_id
        if resolved_instrument_id is None:
            position = await self._find_position(position_id)
            if position:
                resolved_instrument_id = position.get("instrumentID") or position.get("instrumentId")

        if resolved_instrument_id is None:
            logger.error("[eToro] close_position ABORT position=%s reason=instrument_id_not_found", position_id)
            return False

        units_to_deduct = None
        if units is not None:
            try:
                parsed_units = float(units)
                if parsed_units > 0:
                    units_to_deduct = parsed_units
            except (TypeError, ValueError):
                units_to_deduct = None

        path = f"{self.execution_base_path()}/market-close-orders/positions/{position_id}"
        payload = {
            "InstrumentID": int(resolved_instrument_id),
            "UnitsToDeduct": units_to_deduct,
        }

        logger.info(
            "[eToro] close_position REQUEST position=%s path=%s payload=%s",
            position_id, path, json.dumps(payload, default=str),
        )

        try:
            response = await self.arequest("POST", path, json_body=payload, trade_execution=True)
            logger.info(
                "[eToro] close_position RESPONSE position=%s response=%s",
                position_id, json.dumps(response, default=str) if response else "(empty)",
            )
            return True
        except Exception as e:
            logger.error("[eToro] close_position ERROR position=%s error=%s", position_id, e, exc_info=True)
            return False

    async def aget_position_ids_for_order(self, order_id):
        """Return position IDs opened by an order once eToro has executed it."""
        order_status = await self.aget_order_status(order_id)
        if not isinstance(order_status, dict):
            return []

        position_ids = []
        for position in order_status.get("positions", []) or []:
            position_id = position.get("positionID") or position.get("positionId")
            if position_id is not None:
                position_ids.append(str(position_id))
        return position_ids

    async def await_position_ids_for_order(self, order_id, timeout_seconds=30, poll_seconds=2):
        """Poll order info until eToro exposes the opened position IDs."""
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            position_ids = await self.aget_position_ids_for_order(order_id)
            if position_ids:
                return position_ids

            if asyncio.get_running_loop().time() >= deadline:
                return []

            await asyncio.sleep(poll_seconds)

    async def _instrument_id(self, symbol, token):
        try:
            return int(token)
        except (TypeError, ValueError):
            return await self.aresolve_instrument_id(symbol)

    @staticmethod
    def _rate_ltp(rate):
        last = rate.get("lastExecution")
        if last is not None:
            return float(last)
        bid = rate.get("bid")
        ask = rate.get("ask")
        if bid is not None and ask is not None:
            return (float(bid) + float(ask)) / 2
        if bid is not None:
            return float(bid)
        if ask is not None:
            return float(ask)
        return None

    @staticmethod
    def _order_result(response):
        if not isinstance(response, dict):
            return {}

        order = response.get("orderForOpen") or response.get("order") or {}
        order_id = order.get("orderID") or order.get("orderId") or response.get("orderID") or response.get("orderId")
        unique_order_id = response.get("token") or response.get("requestToken") or order.get("requestToken")
        return {
            "order_id": str(order_id) if order_id is not None else None,
            "unique_order_id": unique_order_id,
        }

    def _default_leverage(self):
        return self.leverage

    async def _place_market_open_by_amount(self, payload, side_label):
        endpoint = f"{self.execution_base_path()}/market-open-orders/by-amount"
        logger.info(
            "[eToro] %s request endpoint=%s payload=%s",
            side_label,
            endpoint,
            json.dumps(payload, sort_keys=True),
        )
        try:
            response = await self.arequest(
                "POST",
                endpoint,
                json_body=payload,
                trade_execution=True,
            )
            return self._order_result(response)
        except Exception as e:
            logger.error("[eToro] Exception placing %s order: %s", side_label, e, exc_info=True)
            return {}

    async def _find_position(self, position_id):
        positions = await self.aget_positions()
        target = str(position_id)
        for position in positions:
            candidate = position.get("positionID") or position.get("positionId")
            if str(candidate) == target:
                return position
        return None


class EtoroBracketTradingClient(EtoroTradingClient):
    """eToro client for entries with attached take-profit and stop-loss rates."""

    def is_bo_client(self) -> bool:
        return True

    async def abuy_with_take_profit_stop_loss(
        self,
        ltp,
        available_capital,
        symbol,
        token,
        exchange,
        take_profit_rate,
        stop_loss_rate,
        trailing_stop_loss=False,
    ):
        """Place a long market order with TP/SL attached to the opening order."""
        if available_capital <= 0:
            logger.warning("[eToro] Capital %.2f too low for bracket BUY", available_capital)
            return {}

        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            logger.error("[eToro] Cannot place bracket BUY; unresolved instrument: %s/%s", symbol, token)
            return {}

        try:
            resolved_stop_loss_rate = resolve_bracket_stop_loss_rate(
                ltp,
                stop_loss_rate,
                invested_amount=available_capital,
            )
        except ValueError as exc:
            logger.error("[eToro] %s", exc)
            return {}

        logger.info(
            "[eToro] Placing bracket BUY: symbol=%s amount=%.2f ref_price=%.2f TP=%s SL=%.2f",
            symbol,
            available_capital,
            ltp,
            take_profit_rate,
            resolved_stop_loss_rate,
        )

        payload = {
            "InstrumentID": instrument_id,
            "IsBuy": True,
            "Leverage": self._default_leverage(),
            "Amount": float(available_capital),
        }
        apply_v1_bracket_fields(
            payload,
            stop_loss_rate=resolved_stop_loss_rate,
            take_profit_rate=take_profit_rate,
            trailing_stop_loss=trailing_stop_loss,
        )
        result = await self._place_market_open_by_amount(payload, "bracket BUY")
        if result.get("order_id"):
            result["stop_loss_rate"] = float(resolved_stop_loss_rate)
            if take_profit_rate is not None:
                result["take_profit_rate"] = float(take_profit_rate)
        return result

