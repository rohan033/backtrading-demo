from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from control_plane.news_service import NewsService, finnhub_ticker, get_news_service
from control_plane.watchlist_store import WatchlistStore, get_watchlist_store

log = logging.getLogger("backtrading")

NewsBroadcast = Callable[[list[dict[str, Any]]], Awaitable[None]]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class NewsPoller:
    def __init__(
        self,
        *,
        watchlist_store: WatchlistStore | None = None,
        news_service: NewsService | None = None,
        broadcast: NewsBroadcast | None = None,
    ) -> None:
        self.watchlist_store = watchlist_store or get_watchlist_store()
        self.news_service = news_service or get_news_service()
        self.broadcast = broadcast
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    @property
    def enabled(self) -> bool:
        return _env_bool("NEWS_POLL_ENABLED", True)

    @property
    def interval_seconds(self) -> float:
        return max(30.0, float(os.getenv("NEWS_POLL_INTERVAL_SECONDS", "300")))

    @property
    def request_delay_seconds(self) -> float:
        return max(0.0, float(os.getenv("NEWS_POLL_REQUEST_DELAY_SECONDS", "1.2")))

    async def start(self) -> None:
        if not self.enabled:
            log.info("[NEWS] Poller disabled by NEWS_POLL_ENABLED")
            return
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="news-poller")
        log.info("[NEWS] Poller started interval=%ss", self.interval_seconds)

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
            log.exception("[NEWS] Poller crashed: %s", exc)

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

        all_notifications: list[dict[str, Any]] = []
        for index, ticker in enumerate(tickers):
            if index > 0 and self.request_delay_seconds:
                await asyncio.sleep(self.request_delay_seconds)
            try:
                result = await self.news_service.company_news(
                    ticker,
                    days=30,
                    refresh=True,
                    notify=True,
                )
            except HTTPException as exc:
                if exc.status_code == 429:
                    log.warning("[NEWS] Finnhub rate limited while polling ticker=%s", ticker)
                    break
                log.debug("[NEWS] Poll skipped ticker=%s status=%s", ticker, exc.status_code)
                continue
            except Exception as exc:
                log.warning("[NEWS] Poll failed ticker=%s: %s", ticker, exc)
                continue

            notifications = result.get("notifications") or []
            if notifications:
                all_notifications.extend(notifications)

        if all_notifications and self.broadcast:
            await self.broadcast(all_notifications)
        return all_notifications


_poller: NewsPoller | None = None


def get_news_poller(*, broadcast: NewsBroadcast | None = None) -> NewsPoller:
    global _poller
    if _poller is None:
        _poller = NewsPoller(broadcast=broadcast)
    elif broadcast is not None:
        _poller.broadcast = broadcast
    return _poller
