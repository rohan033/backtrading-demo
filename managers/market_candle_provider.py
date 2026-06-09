"""Background REST candle sync for live charting."""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from logzero import logger

SyncCallback = Callable[[str, str, str, list[dict]], Awaitable[None] | None]
TokenResolver = Callable[[], list[tuple[str, str, str]]]


class MarketCandleProvider:
    """Poll eToro historical candles on start and every minute; pushes full OHLCV snapshots."""

    def __init__(
        self,
        *,
        fetch_candles: Callable[[str, str, str], Awaitable[list[dict]]],
        get_tokens: TokenResolver,
        on_sync: SyncCallback,
        interval_seconds: float = 60.0,
    ):
        self.fetch_candles = fetch_candles
        self.get_tokens = get_tokens
        self.on_sync = on_sync
        self.interval_seconds = interval_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        await self.sync_once()
        self._task = asyncio.create_task(self._loop())
        logger.info(
            "[CandleProvider] Started interval=%.1fs (initial sync complete)",
            self.interval_seconds,
        )

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[CandleProvider] Stopped")

    async def sync_once(self) -> None:
        for exchange, symbol, token in self.get_tokens():
            try:
                candles = await self.fetch_candles(exchange, symbol, token)
            except Exception as exc:
                logger.warning(
                    "[CandleProvider] Candle sync failed symbol=%s token=%s: %s",
                    symbol,
                    token,
                    exc,
                )
                continue
            if not candles:
                continue
            result = self.on_sync(exchange, symbol, token, candles)
            if result is not None:
                await result

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.sync_once()
            except Exception as exc:
                logger.error("[CandleProvider] Sync loop failed: %s", exc, exc_info=True)
            await asyncio.sleep(self.interval_seconds)
