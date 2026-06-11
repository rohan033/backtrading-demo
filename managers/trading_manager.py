import asyncio
import json
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Set
from brokers.interfaces import OrderActivity
from brokers.etoro.ws_order_events import (
    TERMINAL_ACTIONS,
    extract_position_id,
    map_tracked_order_status,
    map_websocket_update,
)
from event.event_manager import EventManager
from logzero import logger

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
MAGENTA = "\033[35m"
BOLD = "\033[1m"
RESET = "\033[0m"


@dataclass
class OrderResult:
    has_executed: bool
    order_id: Optional[str] = None
    unique_order_id: Optional[str] = None
    error_message: Optional[str] = None
    error_code: Optional[str] = None
    permanent_failure: bool = False


class TradingManager:
    def __init__(self, client, event_manager: EventManager,
                 on_event: Optional[Callable[[dict], None]] = None,
                 order_manager=None):
        self.client = client
        self.event_manager = event_manager
        self.order_tracking: Dict[str, Dict] = {}
        self.order_tracking_by_executor: Dict[str, Dict] = {}
        self.order_tracking_by_order_id: Dict[str, Dict] = {}
        self.next_order_id = 1
        self._on_event = on_event
        self.order_manager = order_manager
        self._activity_queue: asyncio.Queue[OrderActivity] = asyncio.Queue(maxsize=1000)
        self._activity_task: asyncio.Task | None = None
        self._emitted_activity_keys: Set[str] = set()

    def is_bo_client(self) -> bool:
        checker = getattr(self.client, "is_bo_client", None)
        return bool(checker()) if callable(checker) else False

    async def start(self):
        if self._activity_task is None:
            self._activity_task = asyncio.create_task(self._order_activity_loop())

    async def stop(self):
        if self._activity_task:
            self._activity_task.cancel()
            try:
                await self._activity_task
            except asyncio.CancelledError:
                pass
            self._activity_task = None

    def enqueue_order_activity(self, activity: OrderActivity) -> None:
        try:
            self._activity_queue.put_nowait(activity)
        except asyncio.QueueFull:
            logger.warning("[TM] Order activity queue full; dropping %s", activity.activity_type)

    async def handle_order_activity(self, activity: OrderActivity) -> None:
        await self._handle_order_activity(activity)

    async def _order_activity_loop(self):
        while True:
            activity = await self._activity_queue.get()
            await self._handle_order_activity(activity)
    
    async def handle_signal(self, executor_id, signal):
        """Handle trading signal by placing appropriate orders"""
        try:
            if signal.decision == "BUY":
                return await self._handle_buy_signal(executor_id, signal)
            elif signal.decision == "SELL":
                return await self._handle_sell_signal(executor_id, signal)
            else:
                logger.info(f"[TM] No action needed for signal: {signal.decision}")
                return OrderResult(has_executed=False)
                
        except Exception as e:
            logger.error(f"[TM] Error handling signal from {executor_id}: {e}")
            return OrderResult(has_executed=False, error_message=str(e))
    
    async def _handle_buy_signal(self, executor_id: str, signal):
        """Handle BUY signal by placing buy order"""
        logger.info(
            "%s[TM]%s Placing BUY  executor=%s  entry=%.2f  qty=%.2f  TP=%.2f  SL=%.2f",
            MAGENTA, RESET, executor_id,
            signal.entry_price, signal.quantity,
            signal.take_profit_price, signal.stop_loss_price
        )
        
        available_capital = signal.entry_price * signal.quantity
        use_bracket_order = (
            self.is_bo_client()
            and hasattr(self.client, "abuy_with_take_profit_stop_loss")
        )
        logger.info(
            "%s[TM]%s BUY dispatch path=%s is_bo_client=%s symbol=%s token=%s exchange=%s "
            "capital=%.2f entry=%.2f qty=%.2f TP=%s SL=%s",
            MAGENTA,
            RESET,
            "bracket" if use_bracket_order else "standard",
            self.is_bo_client(),
            getattr(signal, "symbol", ""),
            getattr(signal, "token", ""),
            getattr(signal, "exchange", "NSE"),
            available_capital,
            signal.entry_price,
            signal.quantity,
            signal.take_profit_price,
            signal.stop_loss_price,
        )
        instrument_class = getattr(signal, "instrument_class", "equity")
        logger.info(
            "%s[TM]%s BUY settlement instrument_class=%s",
            MAGENTA,
            RESET,
            instrument_class,
        )
        if use_bracket_order:
            buy_result = await self.client.abuy_with_take_profit_stop_loss(
                ltp=signal.entry_price,
                available_capital=available_capital,
                symbol=getattr(signal, 'symbol', ''),
                token=getattr(signal, 'token', ''),
                exchange=getattr(signal, 'exchange', 'NSE'),
                take_profit_rate=signal.take_profit_price,
                stop_loss_rate=signal.stop_loss_price,
                instrument_class=instrument_class,
                quantity=getattr(signal, 'quantity', None),
            )
        else:
            buy_result = await self.client.abuy(
                ltp=signal.entry_price,
                available_capital=available_capital,
                symbol=getattr(signal, 'symbol', ''),
                token=getattr(signal, 'token', ''),
                exchange=getattr(signal, 'exchange', 'NSE'),
                instrument_class=instrument_class,
            )
        
        if buy_result and buy_result.get('order_id'):
            # Store order details
            order_details = {
                'executor_id': executor_id,
                'order_id': buy_result['order_id'],
                'unique_order_id': buy_result.get('unique_order_id'),
                'signal': signal,
                'order_type': 'BUY',
                'status': 'placed'
            }
            
            unique_order_id = buy_result.get('unique_order_id') or buy_result['order_id']
            self.order_tracking[unique_order_id] = order_details
            self.order_tracking_by_executor[executor_id] = order_details
            self.order_tracking_by_order_id[str(buy_result['order_id'])] = order_details

            if self.order_manager:
                self.order_manager.register_protected_entry(
                    executor_id=executor_id,
                    order_id=buy_result.get('order_id'),
                    unique_order_id=buy_result.get('unique_order_id'),
                    signal=signal,
                    broker=getattr(self.client, "broker", None),
                    native_bracket_order=self.is_bo_client(),
                )
                if not self.is_bo_client() and hasattr(self.client, "await_position_ids_for_order"):
                    asyncio.create_task(self._resolve_position_id_for_order(executor_id, buy_result.get('order_id')))
                self.order_manager.track_order(buy_result['order_id'])
            
            self.event_manager.log_event(
                order_id=buy_result['order_id'],
                action='BUY_ORDER_PLACED',
                details={
                    'executor_id': executor_id,
                    'unique_order_id': buy_result.get('unique_order_id'),
                    'symbol': getattr(signal, 'symbol', ''),
                    'token': getattr(signal, 'token', ''),
                    'exchange': getattr(signal, 'exchange', 'NSE'),
                    'entry_price': signal.entry_price,
                    'quantity': signal.quantity,
                    'take_profit_price': signal.take_profit_price,
                    'stop_loss_price': signal.stop_loss_price,
                    'pct_change': signal.pct_change,
                    'threshold': signal.threshold,
                    'reason': signal.reason
                }
            )

            if self._on_event:
                try:
                    self._on_event({
                        'type': 'order',
                        'action': 'BUY_ORDER_PLACED',
                        'executor_id': executor_id,
                        'order_id': buy_result['order_id'],
                        'unique_order_id': buy_result.get('unique_order_id'),
                        'symbol': getattr(signal, 'symbol', ''),
                        'entry_price': signal.entry_price,
                        'quantity': signal.quantity,
                        'take_profit_price': signal.take_profit_price,
                        'stop_loss_price': signal.stop_loss_price,
                    })
                except Exception:
                    pass
            
            return OrderResult(
                has_executed=True,
                order_id=buy_result['order_id'],
                unique_order_id=buy_result.get('unique_order_id')
            )
        else:
            error_message = (
                (buy_result or {}).get("error_message")
                or "Buy order placement failed"
            )
            error_code = (buy_result or {}).get("error_code")
            permanent_failure = bool((buy_result or {}).get("permanent_failure"))
            logger.error(
                "%s[TM]%s %sBuy order REJECTED%s  executor=%s  code=%s  msg=%s",
                MAGENTA, RESET, RED, RESET, executor_id, error_code, error_message,
            )
            return OrderResult(
                has_executed=False,
                error_message=error_message,
                error_code=error_code,
                permanent_failure=permanent_failure,
            )
    
    async def _handle_sell_signal(self, executor_id: str, signal):
        """Handle SELL signal by placing sell order"""
        logger.info(f"[TM] Processing SELL signal from {executor_id}: "
                   f"Entry={signal.entry_price}, Qty={signal.quantity}")
        
        # For now, implement basic sell order
        # TODO: Add TP/SL order management logic
        
        return OrderResult(has_executed=False, error_message="Sell logic not implemented yet")

    async def _handle_order_activity(self, activity: OrderActivity) -> None:
        if activity.activity_type in {"take_profit_triggered", "stop_loss_triggered"}:
            await self._handle_tp_sl_activity(activity)
            return

        if activity.source in {"websocket", "polling"}:
            await self._handle_broker_status_activity(activity)

    async def _handle_tp_sl_activity(self, activity: OrderActivity) -> None:
        raw = activity.raw or {}
        executor_id = raw.get("executor_id")
        order_details = (
            self.order_tracking_by_executor.get(str(executor_id))
            or self.order_tracking_by_order_id.get(str(activity.order_id))
        )
        if not order_details:
            logger.warning("[TM] TP/SL trigger could not be correlated: %s", raw)
            return

        signal = order_details.get("signal")
        trigger_price = raw.get("ltp") or getattr(signal, "entry_price", 0.0)
        quantity = raw.get("quantity") or getattr(signal, "quantity", 0)
        symbol = raw.get("symbol") or getattr(signal, "symbol", "")
        token = raw.get("token") or getattr(signal, "token", "")
        exchange = raw.get("exchange") or getattr(signal, "exchange", "NSE")
        position_id = activity.position_id or raw.get("position_id")
        reason = "TAKE_PROFIT" if activity.activity_type == "take_profit_triggered" else "STOP_LOSS"

        exit_result = None
        if position_id and hasattr(self.client, "aclose_position"):
            closed = await self.client.aclose_position(position_id)
            exit_result = {"order_id": activity.order_id, "unique_order_id": raw.get("unique_order_id")} if closed else {}
        elif hasattr(self.client, "aclose_position"):
            logger.error("[TM] TP/SL trigger for executor=%s has no position_id; refusing symbol SELL fallback", executor_id)
            if self.order_manager and executor_id:
                self.order_manager.rearm_protected_entry(str(executor_id))
            return
        elif hasattr(self.client, "asell"):
            exit_result = await self.client.asell(
                ltp=trigger_price,
                quantity=quantity,
                symbol=symbol,
                token=token,
                exchange=exchange,
                orderType="MARKET",
                instrument_class=getattr(signal, "instrument_class", "equity"),
            )
        else:
            logger.error("[TM] Client cannot close TP/SL trigger for executor=%s", executor_id)
            return

        if not exit_result:
            logger.error("[TM] TP/SL exit failed executor=%s trigger=%s", executor_id, activity.activity_type)
            return

        order_details["status"] = "closed"
        order_details["exit_reason"] = reason
        order_details["exit_price"] = trigger_price
        await self._cancel_sibling_exit(raw, activity.activity_type)

        self.event_manager.log_event(
            order_id=exit_result.get("order_id") or activity.order_id,
            action=f"{reason}_EXIT_PLACED",
            details={
                "executor_id": executor_id,
                "entry_order_id": activity.order_id,
                "position_id": position_id,
                "symbol": symbol,
                "token": token,
                "exchange": exchange,
                "quantity": quantity,
                "exit_price": trigger_price,
                "trigger_type": activity.activity_type,
            }
        )
        self._emit({
            "type": "order",
            "action": f"{reason}_EXIT_PLACED",
            "executor_id": executor_id,
            "order_id": exit_result.get("order_id") or activity.order_id,
            "position_id": position_id,
            "symbol": symbol,
            "token": token,
            "exit_price": trigger_price,
            "quantity": quantity,
            "trigger_type": activity.activity_type,
        })

    async def _handle_broker_status_activity(self, activity: OrderActivity) -> None:
        raw = activity.raw or {}
        content = raw.get("content") if isinstance(raw.get("content"), dict) else raw
        event_type = raw.get("event_type") or activity.activity_type

        if activity.activity_type == "tracked_order_status":
            action = map_tracked_order_status(content)
        elif activity.activity_type in {
            "ORDER_FILLED", "ORDER_CANCELLED", "ORDER_REJECTED",
            "ORDER_OPEN", "ORDER_PENDING", "ORDER_MODIFIED",
        }:
            action = activity.activity_type
        elif raw.get("type") == "portfolio_status_update" or activity.source == "websocket":
            action = map_websocket_update(event_type, content)
        else:
            return

        if not action:
            return

        if activity.source == "websocket" and action in TERMINAL_ACTIONS:
            logger.info(
                "[TM] WS order completion action=%s body=%s",
                action,
                json.dumps(raw, default=str, separators=(",", ":")),
            )

        position_id = activity.position_id or extract_position_id(content)
        order_id = activity.order_id or content.get("OrderID") or content.get("orderID")
        order_details = self._find_tracked_order(order_id, position_id)
        if not order_details and action != "POSITION_CLOSED":
            logger.debug(
                "[TM] Ignoring untracked broker status action=%s order=%s event=%s",
                action, order_id, event_type,
            )
            return

        if action in {"ORDER_OPEN", "ORDER_PENDING", "ORDER_FILLED", "ORDER_CANCELLED", "ORDER_REJECTED"}:
            dedupe_key = f"{order_id or position_id}:{action}"
        else:
            dedupe_key = f"{order_id or position_id}:{action}:{activity.status}:{event_type}"
        if dedupe_key in self._emitted_activity_keys:
            return
        self._emitted_activity_keys.add(dedupe_key)

        executor_id = order_details.get("executor_id") if order_details else None
        signal = order_details.get("signal") if order_details else None
        symbol = getattr(signal, "symbol", "") if signal else ""
        token = getattr(signal, "token", "") if signal else activity.instrument_id or ""
        exchange = getattr(signal, "exchange", "NSE") if signal else "ETORO"
        quantity = getattr(signal, "quantity", None) if signal else None
        entry_price = getattr(signal, "entry_price", None) if signal else None

        if action == "ORDER_FILLED" and order_details:
            order_details["status"] = "filled"
            if position_id:
                order_details["position_id"] = position_id
                if self.order_manager and executor_id:
                    self.order_manager.set_protected_position_id(str(executor_id), str(position_id))
        elif action == "POSITION_CLOSED" and order_details:
            order_details["status"] = "closed"
        elif action in {"ORDER_REJECTED", "ORDER_CANCELLED"} and order_details:
            order_details["status"] = action.lower().replace("order_", "")

        details = {
            "executor_id": executor_id,
            "unique_order_id": order_details.get("unique_order_id") if order_details else None,
            "symbol": symbol,
            "token": token,
            "exchange": exchange,
            "entry_price": entry_price,
            "quantity": quantity,
            "position_id": position_id,
            "status_id": activity.status,
            "event_type": event_type,
            "source": activity.source,
            "error_code": content.get("ErrorCode") or content.get("errorCode"),
            "executed_units": content.get("ExecutedUnits") or content.get("executedUnits"),
            "end_rate": content.get("EndRate") or content.get("endRate"),
            "close_reason": content.get("CloseReason") or content.get("closeReason"),
        }

        logger.info(
            "[TM] Broker status -> %s executor=%s order=%s position=%s event=%s status=%s",
            action, executor_id, order_id, position_id, event_type, activity.status,
        )

        self.event_manager.log_event(
            order_id=str(order_id) if order_id else None,
            action=action,
            details=details,
        )
        self._emit({
            "type": "event",
            "action": action,
            "executor_id": executor_id,
            "order_id": order_id,
            "position_id": position_id,
            "symbol": symbol,
            "token": token,
            "exchange": exchange,
            "status_id": activity.status,
            "event_type": event_type,
            "source": activity.source,
            "executed_units": details.get("executed_units"),
            "end_rate": details.get("end_rate"),
        })
        self._emit({
            "type": "portfolio_status_update",
            "action": action,
            "event_type": event_type,
            "executor_id": executor_id,
            "order_id": order_id,
            "position_id": position_id,
            "status_id": activity.status,
            "instrument_id": activity.instrument_id,
            "source": activity.source,
            "content": content,
        })

    def _find_tracked_order(self, order_id: str | None, position_id: str | None) -> Optional[Dict]:
        if order_id:
            tracked = self.order_tracking_by_order_id.get(str(order_id))
            if tracked:
                return tracked

        if position_id:
            for details in self.order_tracking_by_executor.values():
                if str(details.get("position_id")) == str(position_id):
                    return details

        return None

    async def _cancel_sibling_exit(self, raw: dict, trigger_type: str) -> None:
        if not hasattr(self.client, "acancel_order"):
            return

        sibling_key = "stop_loss_order_id" if trigger_type == "take_profit_triggered" else "take_profit_order_id"
        sibling_order_id = raw.get(sibling_key)
        if not sibling_order_id:
            return

        try:
            await self.client.acancel_order(sibling_order_id)
            logger.info("[TM] Cancelled sibling TP/SL order %s", sibling_order_id)
        except Exception as e:
            logger.error("[TM] Failed cancelling sibling TP/SL order %s: %s", sibling_order_id, e)

    async def _resolve_position_id_for_order(self, executor_id: str, order_id: str | None) -> None:
        if not order_id:
            return
        try:
            position_ids = await self.client.await_position_ids_for_order(order_id)
        except Exception as e:
            logger.error("[TM] Failed resolving position for order=%s: %s", order_id, e)
            return

        if not position_ids:
            logger.warning("[TM] No position_id resolved for order=%s within timeout", order_id)
            return

        position_id = position_ids[0]
        details = self.order_tracking_by_executor.get(executor_id)
        if details:
            details["position_id"] = position_id
        if self.order_manager:
            self.order_manager.set_protected_position_id(executor_id, position_id)
        logger.info("[TM] Resolved position_id=%s for executor=%s order=%s", position_id, executor_id, order_id)

    def _emit(self, event: dict) -> None:
        if self._on_event:
            try:
                self._on_event(event)
            except Exception:
                pass
    
    def get_order_status(self, executor_id: str) -> Optional[Dict]:
        """Get order status for a specific executor"""
        return self.order_tracking_by_executor.get(executor_id)
    
    def get_all_orders(self) -> Dict:
        """Get all tracked orders"""
        return self.order_tracking.copy()
