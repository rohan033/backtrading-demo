import sys
import os
import asyncio
import logging
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strategy import Strategy
from tick import Tick
from manual_robo import db

log = logging.getLogger("manual_robo")

IST = timezone(timedelta(hours=5, minutes=30))
POLL_INTERVAL = 15  # seconds

# Engine states
STATE_WATCHING = "watching"
STATE_ENTRY_PLACED = "entry_placed"
STATE_ENTRY_FILLED = "entry_filled"
STATE_DONE = "done"


class ManualRoboEngine:
    def __init__(self, client, session_id):
        self.client = client
        self.session_id = session_id
        self.session = db.get_session(session_id)
        self.state = STATE_WATCHING
        self.strategy = None
        self._task = None
        self._running = False

        self.entry_order_db_id = None
        self.entry_unique_order_id = None
        self.entry_order_id = None
        self.filled_price = None
        self._active_quantity = 0

        self.sl_order_db_id = None
        self.sl_order_id = None
        self.tp_order_db_id = None
        self.tp_order_id = None

    async def start(self):
        session = self.session
        log.info("[ROBO-%d] Starting for %s (%s) qty=%d",
                 self.session_id, session["symbol"], session["token"], session["quantity"])

        closing_tick = await self._fetch_previous_close()
        if not closing_tick:
            log.error("[ROBO-%d] Could not fetch previous close, aborting", self.session_id)
            db.update_session_status(self.session_id, "stopped")
            return

        self.strategy = Strategy(
            last_tick=closing_tick,
            long_percent=session["long_percent"],
            short_percent=session["short_percent"],
            initial_threshold=session["initial_threshold"],
        )
        log.info("[ROBO-%d] Strategy initialized. Prev close=%.2f", self.session_id, closing_tick.close)

        self._running = True
        self._task = asyncio.create_task(self._ltp_loop())

    async def stop(self, reason="stopped"):
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        await self._cancel_pending_orders()
        total_pnl = self.session.get("total_pnl", 0.0) if self.session else 0.0
        db.update_session_status(self.session_id, reason, total_pnl)
        self.state = STATE_DONE
        log.info("[ROBO-%d] Stopped. Reason=%s PnL=%.2f", self.session_id, reason, total_pnl)

    def get_status(self):
        session = db.get_session(self.session_id)
        pending = db.get_pending_orders(self.session_id)
        ltp_history = db.get_ltp_history(self.session_id, limit=5)
        return {
            "session": session,
            "state": self.state,
            "pending_orders": pending,
            "recent_ltp": ltp_history,
            "filled_price": self.filled_price,
        }

    async def _fetch_previous_close(self):
        session = self.session
        try:
            payload = dict(
                exchange=session["exchange"],
                symboltoken=session["token"],
                interval="ONE_MINUTE",
                fromdate=session.get("closing_start", ""),
                todate=session.get("closing_end", ""),
            )
            res = self.client._client.getCandleData(payload)
            if res and res.get("data"):
                candle = res["data"][0]
                return Tick(
                    time=candle[0], open=candle[1], high=candle[2],
                    low=candle[3], close=candle[4], volume=candle[5],
                    token=session["token"]
                )
        except Exception as e:
            log.error("[ROBO-%d] Error fetching prev close: %s", self.session_id, e)
        return None

    async def _ltp_loop(self):
        session = self.session
        symbol = session["symbol"]
        token = session["token"]
        exchange = session["exchange"]

        log.info("[ROBO-%d] LTP loop started. Polling every %ds", self.session_id, POLL_INTERVAL)

        while self._running:
            try:
                ltp = await self._fetch_ltp(exchange, symbol, token)
                if ltp is None:
                    log.warning("[ROBO-%d] LTP fetch returned None, retrying...", self.session_id)
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

                signal = await self._process_ltp(ltp)
                db.log_ltp(self.session_id, ltp, signal)

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error("[ROBO-%d] Error in LTP loop: %s", self.session_id, e)

            await asyncio.sleep(POLL_INTERVAL)

    async def _fetch_ltp(self, exchange, symbol, token):
        try:
            res = self.client._client.ltpData(exchange, symbol, token)
            if res and res.get("data"):
                return float(res["data"]["ltp"])
        except Exception as e:
            log.error("[ROBO-%d] ltpData error: %s", self.session_id, e)
        return None

    async def _process_ltp(self, ltp):
        session = self.session
        token = session["token"]
        tick = Tick(time=datetime.now(IST).isoformat(), open=ltp, high=ltp,
                    low=ltp, close=ltp, volume=0, token=token)

        if self.state == STATE_WATCHING:
            return await self._handle_watching(tick, ltp)
        elif self.state == STATE_ENTRY_PLACED:
            return await self._handle_entry_placed(tick, ltp)
        elif self.state == STATE_ENTRY_FILLED:
            return await self._handle_entry_filled(tick, ltp)

        return "hold"

    async def _handle_watching(self, tick, ltp):
        if self.strategy.should_buy(tick):
            log.info("[ROBO-%d] BUY signal at LTP=%.2f", self.session_id, ltp)
            await self._place_entry_order(ltp)
            return "buy"
        return "hold"

    async def _handle_entry_placed(self, tick, ltp):
        # TODO: add a timeout — if order not filled within N minutes, cancel and return to WATCHING
        filled = await self._check_order_filled(self.entry_unique_order_id, self.entry_order_db_id)
        if filled:
            log.info("[ROBO-%d] Entry order FILLED at %.2f", self.session_id, self.filled_price)
            self.strategy.update_last_tick(tick)
            await self._place_sl_tp_orders(self.filled_price)
            self.state = STATE_ENTRY_FILLED
            return "entry_filled"
        return "waiting_fill"

    async def _handle_entry_filled(self, tick, ltp):
        sl_filled = await self._check_order_filled(
            self._get_unique_order_id("stop_loss"), self.sl_order_db_id
        )
        tp_filled = await self._check_order_filled(
            self._get_unique_order_id("take_profit"), self.tp_order_db_id
        )

        if sl_filled:
            log.info("[ROBO-%d] STOP LOSS hit at %.2f", self.session_id, ltp)
            await self._cancel_order(self.tp_order_id, self.tp_order_db_id, "NORMAL")
            await self._handle_exit("stop_loss", ltp)
            return "sell_sl"

        if tp_filled:
            log.info("[ROBO-%d] TAKE PROFIT hit at %.2f", self.session_id, ltp)
            await self._cancel_order(self.sl_order_id, self.sl_order_db_id, "STOPLOSS")
            await self._handle_exit("take_profit", ltp)
            return "sell_tp"

        if self.strategy.should_sell(tick):
            log.info("[ROBO-%d] Strategy SELL signal at LTP=%.2f", self.session_id, ltp)
            await self._cancel_order(self.sl_order_id, self.sl_order_db_id, "STOPLOSS")
            await self._cancel_order(self.tp_order_id, self.tp_order_db_id, "NORMAL")
            await self._place_exit_order(ltp)
            return "sell_strategy"

        return "hold"

    async def _place_entry_order(self, ltp):
        session = self.session
        quantity = int(session["configured_capital"] / ltp)
        if quantity < 1:
            log.warning("[ROBO-%d] Capital %.2f too low for LTP=%.2f", self.session_id, session["configured_capital"], ltp)
            return
        self._active_quantity = quantity
        log.info("[ROBO-%d] Calculated qty=%d (capital=%.0f / ltp=%.2f)",
                 self.session_id, quantity, session["configured_capital"], ltp)

        order_params = {
            "variety": "NORMAL",
            "tradingsymbol": session["symbol"],
            "symboltoken": session["token"],
            "transactiontype": "BUY",
            "exchange": session["exchange"],
            "ordertype": "LIMIT",
            "producttype": "DELIVERY",
            "duration": "DAY",
            "price": str(ltp),
            "quantity": str(quantity),
        }

        try:
            res = self.client._client.placeOrderFullResponse(order_params)
            log.info("[ROBO-%d] Entry order placed: %s", self.session_id, res)

            if res and res.get("status"):
                data = res.get("data", {})
                order_id = data.get("orderid")
                unique_order_id = data.get("uniqueorderid")

                self.entry_order_db_id = db.insert_order(
                    session_id=self.session_id,
                    transaction_type="BUY",
                    order_type="LIMIT",
                    role="entry",
                    quantity=quantity,
                    price=ltp,
                    order_id=order_id,
                    unique_order_id=unique_order_id,
                    raw_response=res,
                )
                self.entry_unique_order_id = unique_order_id
                self.entry_order_id = order_id
                self.state = STATE_ENTRY_PLACED
            else:
                log.error("[ROBO-%d] Entry order FAILED: %s", self.session_id, res)
        except Exception as e:
            log.error("[ROBO-%d] Exception placing entry order: %s", self.session_id, e)

    async def _place_sl_tp_orders(self, filled_price):
        session = self.session
        sl_price = round(filled_price * (1 - session["short_percent"] / 100), 2)
        tp_price = round(filled_price * (1 + session["long_percent"] / 100), 2)
        sl_limit_price = round(sl_price - 0.05, 2)

        log.info("[ROBO-%d] Placing SL=%.2f TP=%.2f (entry=%.2f)",
                 self.session_id, sl_price, tp_price, filled_price)

        # Stop Loss order
        sl_params = {
            "variety": "STOPLOSS",
            "tradingsymbol": session["symbol"],
            "symboltoken": session["token"],
            "transactiontype": "SELL",
            "exchange": session["exchange"],
            "ordertype": "STOPLOSS_LIMIT",
            "producttype": "DELIVERY",
            "duration": "DAY",
            "price": str(sl_limit_price),
            "triggerprice": str(sl_price),
            "quantity": str(self._active_quantity),
        }

        try:
            sl_res = self.client._client.placeOrderFullResponse(sl_params)
            log.info("[ROBO-%d] SL order response: %s", self.session_id, sl_res)
            if sl_res and sl_res.get("status"):
                sl_data = sl_res.get("data", {})
                self.sl_order_id = sl_data.get("orderid")
                self.sl_order_db_id = db.insert_order(
                    session_id=self.session_id,
                    transaction_type="SELL",
                    order_type="STOPLOSS_LIMIT",
                    role="stop_loss",
                    quantity=self._active_quantity,
                    price=sl_limit_price,
                    trigger_price=sl_price,
                    variety="STOPLOSS",
                    order_id=sl_data.get("orderid"),
                    unique_order_id=sl_data.get("uniqueorderid"),
                    raw_response=sl_res,
                )
        except Exception as e:
            log.error("[ROBO-%d] Exception placing SL order: %s", self.session_id, e)

        # Take Profit order
        tp_params = {
            "variety": "NORMAL",
            "tradingsymbol": session["symbol"],
            "symboltoken": session["token"],
            "transactiontype": "SELL",
            "exchange": session["exchange"],
            "ordertype": "LIMIT",
            "producttype": "DELIVERY",
            "duration": "DAY",
            "price": str(tp_price),
            "quantity": str(self._active_quantity),
        }

        try:
            tp_res = self.client._client.placeOrderFullResponse(tp_params)
            log.info("[ROBO-%d] TP order response: %s", self.session_id, tp_res)
            if tp_res and tp_res.get("status"):
                tp_data = tp_res.get("data", {})
                self.tp_order_id = tp_data.get("orderid")
                self.tp_order_db_id = db.insert_order(
                    session_id=self.session_id,
                    transaction_type="SELL",
                    order_type="LIMIT",
                    role="take_profit",
                    quantity=self._active_quantity,
                    price=tp_price,
                    order_id=tp_data.get("orderid"),
                    unique_order_id=tp_data.get("uniqueorderid"),
                    raw_response=tp_res,
                )
        except Exception as e:
            log.error("[ROBO-%d] Exception placing TP order: %s", self.session_id, e)

    async def _place_exit_order(self, ltp):
        session = self.session
        exit_params = {
            "variety": "NORMAL",
            "tradingsymbol": session["symbol"],
            "symboltoken": session["token"],
            "transactiontype": "SELL",
            "exchange": session["exchange"],
            "ordertype": "MARKET",
            "producttype": "DELIVERY",
            "duration": "DAY",
            "quantity": str(self._active_quantity),
        }

        try:
            res = self.client._client.placeOrderFullResponse(exit_params)
            log.info("[ROBO-%d] Exit order placed: %s", self.session_id, res)
            if res and res.get("status"):
                data = res.get("data", {})
                db.insert_order(
                    session_id=self.session_id,
                    transaction_type="SELL",
                    order_type="MARKET",
                    role="exit",
                    quantity=self._active_quantity,
                    price=ltp,
                    order_id=data.get("orderid"),
                    unique_order_id=data.get("uniqueorderid"),
                    raw_response=res,
                )
            await self._handle_exit("strategy_signal", ltp)
        except Exception as e:
            log.error("[ROBO-%d] Exception placing exit order: %s", self.session_id, e)

    async def _handle_exit(self, reason, exit_price):
        if self.filled_price and exit_price:
            session = self.session
            pnl = (exit_price - self.filled_price) * self._active_quantity
            current_total = (db.get_session(self.session_id) or {}).get("total_pnl", 0.0)
            new_total = current_total + pnl
            db.update_session_pnl(self.session_id, new_total)
            self.session["total_pnl"] = new_total

            log.info("[ROBO-%d] Trade PnL=%.2f Total=%.2f (reason=%s)",
                     self.session_id, pnl, new_total, reason)

            profit_cap = session["configured_capital"] * session["daily_profit_target_pct"] / 100
            if new_total >= profit_cap:
                log.info("[ROBO-%d] PROFIT CAP reached (%.2f >= %.2f). Stopping engine.",
                         self.session_id, new_total, profit_cap)
                await self.stop("profit_capped")
                return

        # Reset state for next trade
        self.state = STATE_WATCHING
        self.entry_order_db_id = None
        self.entry_unique_order_id = None
        self.entry_order_id = None
        self.filled_price = None
        self._active_quantity = 0
        self.sl_order_db_id = None
        self.sl_order_id = None
        self.tp_order_db_id = None
        self.tp_order_id = None
        # Re-init strategy with last known tick for next cycle
        log.info("[ROBO-%d] Ready for next trade cycle", self.session_id)

    async def _check_order_filled(self, unique_order_id, order_db_id):
        if not unique_order_id:
            return False
        try:
            res = self.client._client.individual_order_details(unique_order_id)
            if res and res.get("data"):
                order_data = res["data"]
                status = order_data.get("orderstatus", "").lower()
                if status == "complete":
                    avg_price = float(order_data.get("averageprice", 0))
                    if order_db_id == self.entry_order_db_id:
                        self.filled_price = avg_price
                    db.update_order_status(order_db_id, "filled", avg_price)
                    return True
                elif status in ("rejected", "cancelled"):
                    db.update_order_status(order_db_id, status)
                    log.warning("[ROBO-%d] Order %s is %s", self.session_id, unique_order_id, status)
        except Exception as e:
            log.error("[ROBO-%d] Error checking order %s: %s", self.session_id, unique_order_id, e)
        return False

    async def _cancel_order(self, order_id, order_db_id, variety):
        if not order_id:
            return
        try:
            res = self.client._client.cancelOrder(order_id, variety)
            log.info("[ROBO-%d] Cancel order %s: %s", self.session_id, order_id, res)
            if order_db_id:
                db.update_order_status(order_db_id, "cancelled")
        except Exception as e:
            log.error("[ROBO-%d] Error cancelling order %s: %s", self.session_id, order_id, e)

    async def _cancel_pending_orders(self):
        pending = db.get_pending_orders(self.session_id)
        for order in pending:
            variety = order.get("variety", "NORMAL")
            order_id = order.get("order_id")
            if order_id:
                await self._cancel_order(order_id, order["id"], variety)

    def _get_unique_order_id(self, role):
        orders = db.get_orders_for_session(self.session_id)
        for o in reversed(orders):
            if o["role"] == role and o["status"] == "placed":
                return o.get("unique_order_id")
        return None
