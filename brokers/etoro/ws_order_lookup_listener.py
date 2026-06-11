"""Fetch and persist v2 order lookups when eToro websocket order events arrive."""

from __future__ import annotations

import asyncio
from typing import Any

from logzero import logger

from brokers.etoro.order_helpers import diff_position_executions, lookup_last_update
from brokers.etoro.status_client import _is_order_websocket_event
from managers.bgp_log import bgp_info, bgp_warning, summarize_v2_order_lookup
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
            previous_lookup_row = self.store.get_order_lookup(order_id)
            previous_lookup = (previous_lookup_row or {}).get("lookup")

            lookup = await self.lookup_client.aget_order_status(order_id)
            if not isinstance(lookup, dict) or not lookup:
                bgp_warning("ws_order_lookup_listener", "lookup_empty", order_id=order_id)
                return

            position_changes = diff_position_executions(previous_lookup, lookup)
            current_last_update = lookup_last_update(lookup)
            previous_last_update = lookup_last_update(previous_lookup)
            order_changed = (
                previous_lookup is None
                or (current_last_update and current_last_update != previous_last_update)
                or bool(position_changes)
            )
            if order_changed:
                bgp_info(
                    "ws_order_lookup_listener",
                    "order_lookup_changed",
                    order_id=order_id,
                    previous_last_update=previous_last_update,
                    current_last_update=current_last_update,
                    position_changes=position_changes,
                    lookup=summarize_v2_order_lookup(order_id, lookup),
                )

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
