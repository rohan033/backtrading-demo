import json
from typing import Any

from brokers.etoro.client import EtoroApiError
from brokers.etoro.order_helpers import (
    apply_v2_bracket_fields,
    normalize_etoro_order_payload,
    position_ids_from_order_status,
    resolve_bracket_stop_loss_rate,
    round_etoro_price,
    round_etoro_units,
)
from brokers.etoro.settlement import etoro_settlement_type
from brokers.etoro.trading_client import EtoroTradingClient
from logzero import logger


class EtoroV2OrderClient(EtoroTradingClient):
    """eToro trading client that places and tracks orders via the v2 execution API."""

    def _v2_execution_orders_path(self) -> str:
        if self.account_env == "demo":
            return "/trading/execution/demo/orders"
        return "/trading/execution/orders"

    def _v2_order_lookup_path(self) -> str:
        if self.account_env == "demo":
            return "/trading/info/demo/orders:lookup"
        return "/trading/info/orders:lookup"

    async def abuy(
        self,
        ltp,
        available_capital,
        symbol,
        token,
        exchange,
        variety="NORMAL",
        orderType="LIMIT",
        productType="DELIVERY",
        duration="DAY",
        instrument_class="equity",
    ):
        if available_capital <= 0:
            logger.warning("[eToro] Capital %.2f too low for BUY", available_capital)
            return {}

        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            logger.error("[eToro] Cannot place BUY; unresolved instrument: %s/%s", symbol, token)
            return {}

        logger.info(
            "[eToro v2] Placing BUY: symbol=%s amount=%.2f ref_price=%.2f",
            symbol,
            available_capital,
            ltp,
        )
        payload = self._build_v2_open_payload(
            instrument_id=instrument_id,
            is_buy=True,
            amount=float(available_capital),
            settlement_type=etoro_settlement_type(instrument_class),
        )
        return await self._place_v2_open_order(payload, "BUY")

    async def asell(
        self,
        ltp,
        quantity,
        symbol,
        token,
        exchange,
        variety="NORMAL",
        orderType="LIMIT",
        productType="DELIVERY",
        duration="DAY",
        instrument_class="equity",
    ):
        if quantity <= 0:
            logger.warning("[eToro] Quantity %.4f too low for SELL", quantity)
            return {}

        instrument_id = await self._instrument_id(symbol, token)
        if instrument_id is None:
            logger.error("[eToro] Cannot place SELL; unresolved instrument: %s/%s", symbol, token)
            return {}

        logger.info(
            "[eToro v2] Placing SELL: symbol=%s qty=%.4f price=%.2f",
            symbol,
            quantity,
            ltp,
        )
        payload = self._build_v2_open_payload(
            instrument_id=instrument_id,
            is_buy=False,
            units=float(quantity),
            settlement_type=etoro_settlement_type(instrument_class),
        )
        return await self._place_v2_open_order(payload, "SELL")

    async def acancel_order(self, order_id):
        logger.info("[eToro v2] Cancelling order: %s", order_id)

        try:
            await self.arequest_v2(
                "DELETE",
                f"{self._v2_execution_orders_path()}/{order_id}",
                trade_execution=True,
            )
            return True
        except Exception as exc:
            logger.debug("[eToro v2] Cancel attempt failed for order %s: %s", order_id, exc)

        try:
            await self.arequest(
                "DELETE",
                f"{self.execution_base_path()}/market-close-orders/{order_id}",
                trade_execution=True,
            )
            return True
        except Exception as exc:
            logger.debug("[eToro v2] Close-order cancel fallback failed for %s: %s", order_id, exc)
        return False

    async def aget_order_status(self, order_id):
        logger.info("[eToro v2] Getting order status: %s", order_id)

        try:
            return await self.arequest_v2(
                "GET",
                self._v2_order_lookup_path(),
                params={"orderId": int(order_id)},
            )
        except Exception as exc:
            logger.error("[eToro v2] Error getting order status for %s: %s", order_id, exc, exc_info=True)
            return None

    async def aget_position_ids_for_order(self, order_id):
        order_status = await self.aget_order_status(order_id)
        return position_ids_from_order_status(order_status)

    def _build_v2_open_payload(
        self,
        *,
        instrument_id: int,
        is_buy: bool,
        amount: float | None = None,
        units: float | None = None,
        stop_loss_rate: float | None = None,
        take_profit_rate: float | None = None,
        trailing_stop_loss: bool = False,
        settlement_type: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "action": "open",
            "transaction": "buy" if is_buy else "",
            "instrumentId": int(instrument_id),
            "settlementType": settlement_type or etoro_settlement_type("equity"),
            "orderType": "mkt",
            "leverage": self._default_leverage(),
        }
        if units is not None:
            payload["units"] = round_etoro_units(units)
        elif amount is not None:
            payload["amount"] = round_etoro_price(amount)
            payload["orderCurrency"] = "usd"
        if stop_loss_rate is not None:
            apply_v2_bracket_fields(
                payload,
                stop_loss_rate=stop_loss_rate,
                take_profit_rate=take_profit_rate,
                trailing_stop_loss=trailing_stop_loss,
            )
        return payload

    async def _place_v2_open_order(self, payload: dict[str, Any], side_label: str):
        endpoint = self._v2_execution_orders_path()
        normalized_payload = normalize_etoro_order_payload(payload)
        logger.info(
            "[eToro v2] %s request endpoint=%s payload=%s",
            side_label,
            endpoint,
            json.dumps(normalized_payload, sort_keys=True),
        )
        try:
            response = await self.arequest_v2(
                "POST",
                endpoint,
                json_body=normalized_payload,
                trade_execution=True,
            )
            return self._order_result(response)
        except EtoroApiError as exc:
            logger.error(
                "[eToro v2] Exception placing %s order: %s",
                side_label,
                exc,
                exc_info=True,
            )
            return {}
        except Exception as exc:
            logger.error("[eToro v2] Exception placing %s order: %s", side_label, exc, exc_info=True)
            return {}


class EtoroV2BracketOrderClient(EtoroV2OrderClient):
    """eToro v2 client for entries with attached stop-loss and optional take-profit."""

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
        instrument_class="equity",
        quantity: float | None = None,
    ):
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

        units = None
        if quantity is not None:
            try:
                parsed_units = round_etoro_units(quantity)
            except (TypeError, ValueError):
                parsed_units = None
            if parsed_units is not None and parsed_units > 0:
                units = parsed_units
        if units is None and ltp:
            try:
                derived = round_etoro_units(float(available_capital) / float(ltp))
                if derived and derived > 0:
                    units = derived
            except (TypeError, ValueError, ZeroDivisionError):
                units = None
        if units is not None and units <= 0:
            logger.error(
                "[eToro] Bracket BUY aborted for %s: computed units=%s (amount=%.2f ltp=%s)",
                symbol,
                units,
                available_capital,
                ltp,
            )
            return {}

        settlement_type = etoro_settlement_type(instrument_class)
        sizing = f"units={units}" if units is not None else f"amount={available_capital:.2f}"
        logger.info(
            "[eToro v2] Placing bracket BUY: symbol=%s %s ref_price=%.2f "
            "TP=%s SL=%.2f settlementType=%s instrument_class=%s",
            symbol,
            sizing,
            ltp,
            take_profit_rate,
            resolved_stop_loss_rate,
            settlement_type,
            instrument_class,
        )

        payload = self._build_v2_open_payload(
            instrument_id=instrument_id,
            is_buy=True,
            amount=None if units is not None else float(available_capital),
            units=units,
            stop_loss_rate=resolved_stop_loss_rate,
            take_profit_rate=take_profit_rate,
            trailing_stop_loss=trailing_stop_loss,
            settlement_type=settlement_type,
        )
        result = await self._place_v2_open_order(payload, "bracket BUY")
        if result.get("order_id"):
            result["stop_loss_rate"] = float(resolved_stop_loss_rate)
            if take_profit_rate is not None:
                result["take_profit_rate"] = float(take_profit_rate)
        return result
