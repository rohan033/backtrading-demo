"""Fetch and persist v2 order lookups when eToro websocket order events arrive."""

from __future__ import annotations

import asyncio
from typing import Any

from logzero import logger

from brokers.etoro.status_client import _is_order_websocket_event
from brokers.interfaces import OrderActivity
from event.db_event_consumer import DbEventWriter


class EtoroWsOrderLookupListener:
    """On eToro order websocket updates, call v2 orders:lookup and persist the response."""

    def __init__(
        self,
        lookup_client: Any,
        store: DbEventWriter,
        account_env: str,
    ):
        self.lookup_client = lookup_client
        self.store = store
        self.account_env = account_env
        self._inflight: set[str] = set()

    def enqueue_order_activity(self, activity: OrderActivity) -> None:
        if not self._should_lookup(activity):
            return
        asyncio.create_task(self._lookup_and_persist(str(activity.order_id)))

    async def handle_order_activity(self, activity: OrderActivity) -> None:
        self.enqueue_order_activity(activity)

    def _should_lookup(self, activity: OrderActivity) -> bool:
        if activity.source != "websocket" or not activity.order_id:
            return False
        if not hasattr(self.lookup_client, "aget_order_status"):
            return False

        raw = activity.raw or {}
        event_type = raw.get("event_type") or activity.activity_type
        if raw.get("type") == "portfolio_status_update":
            return _is_order_websocket_event(event_type)
        return _is_order_websocket_event(event_type)

    async def _lookup_and_persist(self, order_id: str) -> None:
        if order_id in self._inflight:
            return

        self._inflight.add(order_id)
        try:
            lookup = await self.lookup_client.aget_order_status(order_id)
            if not isinstance(lookup, dict) or not lookup:
                logger.debug("[eToro] v2 order lookup returned no data for order=%s", order_id)
                return

            self.store.upsert_order_lookup(
                order_id,
                lookup,
                account_env=self.account_env,
            )
            self.store.ensure_order_poll_job_running(order_id)
        except Exception as exc:
            logger.error("[eToro] v2 order lookup failed for order=%s: %s", order_id, exc)
        finally:
            self._inflight.discard(order_id)
