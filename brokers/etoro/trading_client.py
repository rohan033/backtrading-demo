import asyncio
import json
from typing import Any

from brokers.etoro.client import EtoroApiError, EtoroClient
from brokers.etoro.order_helpers import (
    apply_v1_bracket_fields,
    normalize_etoro_order_payload,
    resolve_bracket_stop_loss_rate,
    round_etoro_price,
)
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
            "Amount": round_etoro_price(available_capital),
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

    async def aget_trade_history(
        self,
        *,
        min_date: str | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> list[dict[str, Any]]:
        """Closed trades from trade/history (exact openRate/closeRate/netProfit).

        Demo: GET /trading/info/trade/demo/history
        Real: GET /trading/info/trade/history
        """
        from datetime import date, timedelta

        if not min_date:
            min_date = (date.today() - timedelta(days=2)).isoformat()

        params = {"minDate": min_date, "page": int(page), "pageSize": int(page_size)}
        # Real: /trading/info/trade/history
        # Demo: /trading/info/trade/demo/history
        if self.account_env == "demo":
            paths = [
                "/trading/info/trade/demo/history",
                "/trading/info/demo/trade/history",
            ]
        else:
            paths = [
                "/trading/info/trade/history",
                f"{self.info_base_path()}/trade/history",
            ]
        last_error: Exception | None = None
        for path in paths:
            try:
                response = await self.arequest("GET", path, params=params)
                if isinstance(response, list):
                    return [row for row in response if isinstance(row, dict)]
                if isinstance(response, dict):
                    for key in ("trades", "history", "items", "data"):
                        rows = response.get(key)
                        if isinstance(rows, list):
                            return [row for row in rows if isinstance(row, dict)]
                return []
            except Exception as exc:
                last_error = exc
                logger.debug("[eToro] trade/history %s failed: %s", path, exc)
        if last_error is not None:
            raise last_error
        return []

    async def afind_closed_trade(
        self,
        *,
        position_id: str | int | None = None,
        order_id: str | int | None = None,
        min_date: str | None = None,
        page_size: int = 50,
        max_pages: int = 3,
    ) -> dict[str, Any] | None:
        """Find a closed trade row matching positionId and/or opening orderId."""
        want_pid = str(position_id) if position_id not in (None, "") else None
        want_oid = str(order_id) if order_id not in (None, "") else None
        if not want_pid and not want_oid:
            return None

        for page in range(1, max_pages + 1):
            rows = await self.aget_trade_history(
                min_date=min_date,
                page=page,
                page_size=page_size,
            )
            if not rows:
                break
            for row in rows:
                pid = str(
                    row.get("positionId")
                    or row.get("positionID")
                    or row.get("PositionID")
                    or ""
                )
                oid = str(row.get("orderId") or row.get("orderID") or row.get("OrderID") or "")
                if want_pid and pid == want_pid:
                    return row
                if want_oid and oid == want_oid:
                    return row
            if len(rows) < page_size:
                break
        return None

    async def await_settled_closed_trade(
        self,
        *,
        position_id: str | int | None = None,
        order_id: str | int | None = None,
        attempts: int = 4,
        delay_sec: float = 0.8,
        min_date: str | None = None,
    ) -> dict[str, Any] | None:
        """Poll trade/history until the closed fill appears (can lag after market-close)."""
        for i in range(max(1, int(attempts))):
            row = await self.afind_closed_trade(
                position_id=position_id,
                order_id=order_id,
                min_date=min_date,
            )
            if row:
                return row
            if i + 1 < attempts:
                await asyncio.sleep(float(delay_sec))
        return None

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
    ) -> dict:
        """Close a specific position on eToro.

        When units is omitted or <= 0, eToro closes the full position.
        Returns a dict with request/response debug info. Raises EtoroApiError on broker failure.
        """
        logger.info(
            "[eToro] close_position START position=%s units=%s instrument=%s",
            position_id,
            units,
            instrument_id,
        )

        units_to_deduct = None
        if units is not None:
            try:
                parsed_units = float(units)
                if parsed_units > 0:
                    units_to_deduct = parsed_units
            except (TypeError, ValueError):
                units_to_deduct = None

        # Fast path: caller already knows instrument id — skip the portfolio GET
        # that otherwise adds a full round-trip before every close.
        if instrument_id is not None:
            try:
                resolved_instrument_id = int(instrument_id)
            except (TypeError, ValueError) as exc:
                raise EtoroApiError(
                    f"Invalid instrument_id for close: {instrument_id}",
                    payload={"request": {"position_id": str(position_id), "instrument_id": instrument_id}},
                ) from exc
            if str(position_id) == str(resolved_instrument_id):
                raise EtoroApiError(
                    f"Position {position_id} looks like an instrument id, not a broker position id",
                    payload={
                        "request": {
                            "position_id": str(position_id),
                            "instrument_id": resolved_instrument_id,
                        }
                    },
                )
            close_target = str(position_id)
            logger.info(
                "[eToro] close_position fast_path position=%s instrument=%s (skip portfolio lookup)",
                close_target,
                resolved_instrument_id,
            )
        else:
            position = await self._find_position(position_id)
            if not position:
                logger.error(
                    "[eToro] close_position ABORT position=%s reason=not_found_in_open_portfolio",
                    position_id,
                )
                raise EtoroApiError(
                    f"Position {position_id} not found in open eToro portfolio",
                    payload={"request": {"position_id": str(position_id)}},
                )

            broker_position_id = position.get("positionID") or position.get("positionId")
            resolved_instrument_id = position.get("instrumentID") or position.get("instrumentId")
            if resolved_instrument_id is None:
                logger.error(
                    "[eToro] close_position ABORT position=%s reason=instrument_id_not_found",
                    position_id,
                )
                raise EtoroApiError(
                    f"Position {position_id} is missing instrumentID in eToro portfolio",
                    payload={"request": {"position_id": str(position_id), "position": position}},
                )

            if str(broker_position_id) == str(resolved_instrument_id):
                logger.error(
                    "[eToro] close_position ABORT position=%s reason=position_id_matches_instrument_id",
                    position_id,
                )
                raise EtoroApiError(
                    f"Position {position_id} looks like an instrument id, not a broker position id",
                    payload={
                        "request": {
                            "position_id": str(position_id),
                            "broker_position_id": broker_position_id,
                            "instrument_id": resolved_instrument_id,
                        }
                    },
                )

            close_target = str(broker_position_id or position_id)
        path = f"{self.execution_base_path()}/market-close-orders/positions/{close_target}"
        payload = normalize_etoro_order_payload({
            "InstrumentID": int(resolved_instrument_id),
            "UnitsToDeduct": units_to_deduct,
        })
        request_debug = {
            "method": "POST",
            "path": path,
            "payload": payload,
            "position_id": close_target,
            "instrument_id": int(resolved_instrument_id),
            "units_to_deduct": units_to_deduct,
        }

        logger.info(
            "[eToro] close_position REQUEST position=%s path=%s payload=%s",
            close_target, path, json.dumps(payload, default=str),
        )

        try:
            response = await self.arequest("POST", path, json_body=payload, trade_execution=True)
            logger.info(
                "[eToro] close_position RESPONSE position=%s response=%s",
                close_target, json.dumps(response, default=str) if response else "(empty)",
            )
            return {
                "closed": True,
                "request": request_debug,
                "response": response,
            }
        except EtoroApiError as exc:
            logger.error(
                "[eToro] close_position ERROR position=%s request=%s response=%s",
                close_target,
                json.dumps(request_debug, default=str),
                json.dumps(exc.payload, default=str) if exc.payload is not None else "(none)",
                exc_info=True,
            )
            if exc.payload is None:
                exc.payload = {"request": request_debug}
            elif isinstance(exc.payload, dict) and "request" not in exc.payload:
                exc.payload = {**exc.payload, "request": request_debug}
            raise
        except Exception as exc:
            logger.error(
                "[eToro] close_position ERROR position=%s request=%s error=%s",
                close_target,
                json.dumps(request_debug, default=str),
                exc,
                exc_info=True,
            )
            raise EtoroApiError(str(exc), payload={"request": request_debug, "response": str(exc)}) from exc

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
        for key in ("lastExecution", "LastExecution", "close", "Close"):
            last = rate.get(key)
            if last is not None:
                return float(last)
        bid = rate.get("bid") or rate.get("Bid")
        ask = rate.get("ask") or rate.get("Ask")
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
        normalized_payload = normalize_etoro_order_payload(payload)
        logger.info(
            "[eToro] %s request endpoint=%s payload=%s",
            side_label,
            endpoint,
            json.dumps(normalized_payload, sort_keys=True),
        )
        try:
            response = await self.arequest(
                "POST",
                endpoint,
                json_body=normalized_payload,
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
            "Amount": round_etoro_price(available_capital),
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

