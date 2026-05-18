import asyncio

from logzero import logger
from brokers.interfaces import TickClient, TickListener, Subscription, TickData


class TickProvider:
    def __init__(self, client: TickClient, interval_seconds: float = 1.0):
        self._client = client
        self._interval = interval_seconds
        self._subscriptions: list[Subscription] = []
        self._listeners: dict[str, TickListener] = {}
        self._running = False
        self._task: asyncio.Task | None = None

    def subscribe(self, exchange: str, symbol: str, token: str):
        self._subscriptions.append(Subscription(exchange=exchange, symbol=symbol, token=token))

    def register_listener(self, listener_id: str, listener: TickListener):
        self._listeners[listener_id] = listener
        self._update_subscriptions()

    def unregister_listener(self, listener_id: str):
        self._listeners.pop(listener_id, None)
        self._update_subscriptions()

    def _update_subscriptions(self):
        subscription_set = set()

        for listener in self._listeners.values():
            required_subs = listener.get_required_subscriptions()
            for sub in required_subs:
                sub_key = (sub.exchange, sub.symbol, sub.token)
                subscription_set.add(sub_key)

        self._subscriptions = [
            Subscription(exchange=key[0], symbol=key[1], token=key[2])
            for key in subscription_set
        ]
        logger.info("Updated subscriptions: %d active, %d listeners",
                    len(self._subscriptions), len(self._listeners))

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("TickProvider started with interval=%.2fs, %d subscriptions",
                    self._interval, len(self._subscriptions))

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("TickProvider stopped")

    async def _poll_loop(self):
        while self._running:
            await self._fetch_and_dispatch()
            await asyncio.sleep(self._interval)

    async def _fetch_and_dispatch(self):
        if not self._subscriptions:
            return

        ltp_data_list = await self._client.aget_ltp_bulk(self._subscriptions)
        for ltp_data in ltp_data_list:
            tick = TickData(
                symbol=ltp_data.symbol,
                token=ltp_data.token,
                ltp=ltp_data.ltp,
                exchange=ltp_data.exchange,
            )
            self._dispatch(tick)

    def _dispatch(self, tick: TickData):
        listener = self._listeners.get(tick.token)
        if listener:
            try:
                listener.enqueue_tick(tick)
            except Exception as e:
                logger.error("Dispatch error for %s: %s", tick.symbol, e)
