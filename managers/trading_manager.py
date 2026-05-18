from dataclasses import dataclass
from typing import Dict, Optional
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


class TradingManager:
    def __init__(self, client, event_manager: EventManager):
        self.client = client
        self.event_manager = event_manager
        self.order_tracking: Dict[str, Dict] = {}  # executor_id -> order_details
        self.next_order_id = 1
    
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
            "%s[TM]%s Placing BUY  executor=%s  entry=%.2f  qty=%d  TP=%.2f  SL=%.2f",
            MAGENTA, RESET, executor_id,
            signal.entry_price, signal.quantity,
            signal.take_profit_price, signal.stop_loss_price
        )
        
        # Place buy order
        buy_result = await self.client.abuy(
            ltp=signal.entry_price,
            available_capital=signal.entry_price * signal.quantity,
            symbol=getattr(signal, 'symbol', ''),
            token=getattr(signal, 'token', ''),
            exchange=getattr(signal, 'exchange', 'NSE')
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
            
            self.order_tracking[buy_result.get('unique_order_id')] = order_details
            
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
            
            return OrderResult(
                has_executed=True,
                order_id=buy_result['order_id'],
                unique_order_id=buy_result.get('unique_order_id')
            )
        else:
            logger.error("%s[TM]%s %sBuy order REJECTED%s  executor=%s", MAGENTA, RESET, RED, RESET, executor_id)
            return OrderResult(
                has_executed=False,
                error_message="Buy order placement failed"
            )
    
    async def _handle_sell_signal(self, executor_id: str, signal):
        """Handle SELL signal by placing sell order"""
        logger.info(f"[TM] Processing SELL signal from {executor_id}: "
                   f"Entry={signal.entry_price}, Qty={signal.quantity}")
        
        # For now, implement basic sell order
        # TODO: Add TP/SL order management logic
        
        return OrderResult(has_executed=False, error_message="Sell logic not implemented yet")
    
    def get_order_status(self, executor_id: str) -> Optional[Dict]:
        """Get order status for a specific executor"""
        return self.order_tracking.get(executor_id)
    
    def get_all_orders(self) -> Dict:
        """Get all tracked orders"""
        return self.order_tracking.copy()
