from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from control_plane.insider_store import get_insider_store
from control_plane.news_service import NewsService, finnhub_ticker, get_news_service
from control_plane.watchlist_store import WatchlistStore, get_watchlist_store

log = logging.getLogger("backtrading")

InsiderBroadcast = Callable[[list[dict[str, Any]]], Awaitable[None]]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class InsiderPoller:
    def __init__(
        self,
        *,
        watchlist_store: WatchlistStore | None = None,
        news_service: NewsService | None = None,
        broadcast: InsiderBroadcast | None = None,
    ) -> None:
        self.watchlist_store = watchlist_store or get_watchlist_store()
        self.news_service = news_service or get_news_service()
        self.broadcast = broadcast
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    @property
    def enabled(self) -> bool:
        return _env_bool("INSIDER_POLL_ENABLED", True)

    @property
    def interval_seconds(self) -> float:
        return max(60.0, float(os.getenv("INSIDER_POLL_INTERVAL_SECONDS", "900")))

    @property
    def lookback_days(self) -> int:
        return max(7, min(int(os.getenv("INSIDER_POLL_LOOKBACK_DAYS", "90")), 365))

    @property
    def concurrency(self) -> int:
        return max(1, int(os.getenv("INSIDER_POLL_CONCURRENCY", "4")))

    async def start(self) -> None:
        if not self.enabled:
            log.info("[INSIDER] Poller disabled by INSIDER_POLL_ENABLED")
            return
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="insider-poller")
        log.info("[INSIDER] Poller started interval=%ss", self.interval_seconds)

    async def stop(self) -> None:
        self._stopped.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        try:
            while not self._stopped.is_set():
                await self.poll_once()
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=self.interval_seconds)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("[INSIDER] Poller crashed: %s", exc)

    def watchlist_tickers(self) -> list[str]:
        tickers: set[str] = set()
        for watchlist in self.watchlist_store.list_watchlists():
            for symbol in watchlist.get("symbols") or []:
                raw = symbol.get("tradingsymbol") or symbol.get("symbol") or ""
                ticker = finnhub_ticker(str(raw))
                if ticker:
                    tickers.add(ticker)
        return sorted(tickers)

    async def poll_once(self) -> list[dict[str, Any]]:
        tickers = self.watchlist_tickers()
        if not tickers:
            return []

        store = get_insider_store()
        all_new: list[dict[str, Any]] = []
        semaphore = asyncio.Semaphore(self.concurrency)

        async def fetch_ticker(ticker: str) -> None:
            async with semaphore:
                try:
                    result = await self.news_service.insider_transactions(
                        ticker,
                        days=self.lookback_days,
                    )
                except HTTPException as exc:
                    if exc.status_code == 429:
                        log.warning("[INSIDER] Finnhub rate limited while polling ticker=%s", ticker)
                    else:
                        log.debug("[INSIDER] Poll skipped ticker=%s status=%s", ticker, exc.status_code)
                    return
                except Exception as exc:
                    log.warning("[INSIDER] Poll failed ticker=%s: %s", ticker, exc)
                    return

                rows = result.get("data") or []
                if not isinstance(rows, list):
                    return
                inserted = store.upsert_transactions(ticker, rows)
                if inserted:
                    all_new.extend(inserted)

        await asyncio.gather(*(fetch_ticker(ticker) for ticker in tickers))
        store.set_poll_timestamp()
        self.news_service._watchlist_insider_cache = None

        if all_new and self.broadcast:
            await self.broadcast(all_new)
        return all_new


_poller: InsiderPoller | None = None


def get_insider_poller(*, broadcast: InsiderBroadcast | None = None) -> InsiderPoller:
    global _poller
    if _poller is None:
        _poller = InsiderPoller(broadcast=broadcast)
    elif broadcast is not None:
        _poller.broadcast = broadcast
    return _poller
