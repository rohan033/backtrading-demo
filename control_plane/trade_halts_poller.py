from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, timedelta
from typing import Any, Awaitable, Callable

from control_plane.trade_halts_service import fetch_trade_halts_rss
from control_plane.trade_halts_store import TradeHaltsStore, get_trade_halts_store, make_halt_id

log = logging.getLogger("backtrading")

HaltsBroadcast = Callable[[list[dict[str, Any]]], Awaitable[None]]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class TradeHaltsPoller:
    """Fetch NASDAQ trade-halt RSS every minute; purge older rows every 4 hours."""

    def __init__(
        self,
        *,
        store: TradeHaltsStore | None = None,
        broadcast: HaltsBroadcast | None = None,
    ) -> None:
        self.store = store or get_trade_halts_store()
        self.broadcast = broadcast
        self._poll_task: asyncio.Task | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    @property
    def enabled(self) -> bool:
        return _env_bool("TRADE_HALTS_POLL_ENABLED", True)

    @property
    def interval_seconds(self) -> float:
        return max(30.0, float(os.getenv("TRADE_HALTS_POLL_INTERVAL_SECONDS", "60")))

    @property
    def cleanup_interval_seconds(self) -> float:
        return max(
            300.0,
            float(os.getenv("TRADE_HALTS_CLEANUP_INTERVAL_SECONDS", str(4 * 3600))),
        )

    async def start(self) -> None:
        if not self.enabled:
            log.info("[HALTS] Poller disabled by TRADE_HALTS_POLL_ENABLED")
            return
        if self._poll_task is not None and not self._poll_task.done():
            return
        self._stopped.clear()
        self._poll_task = asyncio.create_task(self._run_poll(), name="trade-halts-poller")
        self._cleanup_task = asyncio.create_task(
            self._run_cleanup(),
            name="trade-halts-cleanup",
        )
        log.info(
            "[HALTS] Poller started interval=%ss cleanup=%ss",
            self.interval_seconds,
            self.cleanup_interval_seconds,
        )

    async def stop(self) -> None:
        self._stopped.set()
        for task in (self._poll_task, self._cleanup_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._poll_task = None
        self._cleanup_task = None

    async def _run_poll(self) -> None:
        try:
            while not self._stopped.is_set():
                await self.poll_once()
                try:
                    await asyncio.wait_for(
                        self._stopped.wait(),
                        timeout=self.interval_seconds,
                    )
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("[HALTS] Poller crashed: %s", exc)

    async def _run_cleanup(self) -> None:
        try:
            while not self._stopped.is_set():
                await self.cleanup_once()
                try:
                    await asyncio.wait_for(
                        self._stopped.wait(),
                        timeout=self.cleanup_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("[HALTS] Cleanup crashed: %s", exc)

    async def poll_once(self) -> list[dict[str, Any]]:
        try:
            entries = await fetch_trade_halts_rss()
        except Exception as exc:
            log.warning("[HALTS] RSS fetch failed: %s", exc)
            return []

        notifications = self.store.upsert_halts(entries)
        keep_ids = {
            make_halt_id(
                str(entry.get("symbol") or "").strip().upper(),
                str(entry.get("halt_date") or "").strip(),
                str(entry.get("halt_time") or "").strip(),
            )
            for entry in entries
            if str(entry.get("symbol") or "").strip() and str(entry.get("halt_date") or "").strip()
        }
        purged = self.store.purge_missing_ids(keep_ids)
        if purged["halts_deleted"]:
            log.info(
                "[HALTS] Removed %s stale halt row(s) no longer in feed",
                purged["halts_deleted"],
            )
        if notifications:
            log.info("[HALTS] %s new notification(s) from %s entries", len(notifications), len(entries))
            if self.broadcast:
                await self.broadcast(notifications)
        else:
            log.debug("[HALTS] Polled %s entries; no new notifications", len(entries))
        return notifications

    async def cleanup_once(self) -> dict[str, int]:
        # Safety net: drop rows that somehow stopped updating (not in feed) for > 2 days.
        keep_from = (date.today() - timedelta(days=2)).isoformat()
        result = self.store.purge_older_than(keep_from)
        if result["halts_deleted"] or result["notifications_deleted"]:
            log.info(
                "[HALTS] Purged older rows keep_from=%s halts=%s notifications=%s",
                keep_from,
                result["halts_deleted"],
                result["notifications_deleted"],
            )
        return result


_poller: TradeHaltsPoller | None = None


def get_trade_halts_poller(*, broadcast: HaltsBroadcast | None = None) -> TradeHaltsPoller:
    global _poller
    if _poller is None:
        _poller = TradeHaltsPoller(broadcast=broadcast)
    elif broadcast is not None:
        _poller.broadcast = broadcast
    return _poller
