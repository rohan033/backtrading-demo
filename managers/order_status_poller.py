"""Strategy-scoped order status poller that runs inside the live engine."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from logzero import logger

from managers.bgp_log import bgp_info, bgp_warning, summarize_v2_order_lookup
from brokers.etoro.order_helpers import (
    classify_order_poll_outcome,
    diff_position_executions,
    lookup_last_update,
)

if TYPE_CHECKING:
    from api.live_server import LiveEngine


class LiveOrderStatusPoller:
    """Poll eToro v2 order lookup for this live engine's executors until fulfillment."""

    def __init__(self, engine: LiveEngine, poll_interval_seconds: float = 5.0):
        self.engine = engine
        self.poll_interval_seconds = poll_interval_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info(
            "[OrderPoll] Live poller started engine_id=%s interval=%.1fs",
            self.engine.engine_id or "-",
            self.poll_interval_seconds,
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
        logger.info(
            "[OrderPoll] Live poller stopped engine_id=%s",
            self.engine.engine_id or "-",
        )

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.poll_once()
            except Exception as exc:
                logger.error("[OrderPoll] Poll loop failed: %s", exc, exc_info=True)
            await asyncio.sleep(self.poll_interval_seconds)

    async def poll_once(self) -> None:
        store = self.engine.db_writer
        if store is None:
            return

        jobs = store.list_order_poll_jobs(status="RUNNING")
        for job in jobs:
            if not self._owns_job(job):
                continue
            await self._poll_job(job)

    def _owns_job(self, job: dict[str, Any]) -> bool:
        engine_id = job.get("engine_id")
        if engine_id and self.engine.engine_id:
            return str(engine_id) == str(self.engine.engine_id)

        executor_id = job.get("executor_id")
        return bool(executor_id and executor_id in self.engine.executors)

    async def _poll_job(self, job: dict[str, Any]) -> None:
        order_id = job.get("order_id")
        executor_id = job.get("executor_id")
        if not order_id or not executor_id:
            return

        client = self.engine.client
        if client is None or not hasattr(client, "aget_order_status"):
            return

        store = self.engine.db_writer
        previous_lookup_row = store.get_order_lookup(order_id)
        previous_lookup = (previous_lookup_row or {}).get("lookup")
        previous_last_update = (
            job.get("last_remote_update")
            or lookup_last_update(previous_lookup)
        )

        lookup = await client.aget_order_status(order_id)
        if not isinstance(lookup, dict) or not lookup:
            bgp_warning(
                "live_order_status_poller",
                "lookup_empty",
                executor_id=str(executor_id),
                order_id=str(order_id),
            )
            return

        current_last_update = lookup_last_update(lookup)
        store.upsert_order_lookup(
            order_id,
            lookup,
            account_env=job.get("account_env") or self.engine.account_env,
            executor_id=str(executor_id),
        )
        store.touch_order_poll_job(executor_id, order_id, lookup)
        if current_last_update:
            store.set_order_poll_last_remote_update(executor_id, order_id, current_last_update)

        position_changes = diff_position_executions(previous_lookup, lookup)
        order_changed = (
            previous_lookup is None
            or (current_last_update and current_last_update != previous_last_update)
            or bool(position_changes)
        )
        if order_changed:
            bgp_info(
                "live_order_status_poller",
                "order_lookup_changed",
                executor_id=str(executor_id),
                order_id=str(order_id),
                previous_last_update=previous_last_update,
                current_last_update=current_last_update,
                position_changes=position_changes,
                lookup=summarize_v2_order_lookup(str(order_id), lookup),
            )
            await self._emit_lookup_update(
                job=job,
                lookup=lookup,
                position_changes=position_changes,
                previous_last_update=previous_last_update,
                current_last_update=current_last_update,
            )

        outcome = classify_order_poll_outcome(lookup)
        if outcome == "fulfilled":
            bgp_info(
                "live_order_status_poller",
                "order_terminal_fulfilled",
                executor_id=str(executor_id),
                order_id=str(order_id),
                lookup=summarize_v2_order_lookup(str(order_id), lookup),
            )
            await self._handle_fulfilled(job, lookup)
        elif outcome == "rejected":
            bgp_warning(
                "live_order_status_poller",
                "order_terminal_rejected",
                executor_id=str(executor_id),
                order_id=str(order_id),
                lookup=summarize_v2_order_lookup(str(order_id), lookup),
            )
            await self._handle_rejected(job, lookup)

    async def _emit_lookup_update(
        self,
        *,
        job: dict[str, Any],
        lookup: dict[str, Any],
        position_changes: list[dict[str, Any]],
        previous_last_update: str | None,
        current_last_update: str | None,
    ) -> None:
        executor_id = str(job["executor_id"])
        order_id = str(job["order_id"])
        store = self.engine.db_writer
        asset = lookup.get("asset") or {}
        status = lookup.get("status") or {}

        if current_last_update and current_last_update != previous_last_update:
            details = {
                "executor_id": executor_id,
                "source": "live_order_status_poller",
                "last_update": current_last_update,
                "previous_last_update": previous_last_update,
                "order_status": status,
                "symbol": asset.get("symbol"),
                "token": asset.get("instrumentId"),
            }
            store.log_event(order_id, "ORDER_STATUS_UPDATED", details)
            self._broadcast({
                "type": "order_poll_update",
                "action": "ORDER_STATUS_UPDATED",
                "executor_id": executor_id,
                "order_id": order_id,
                "last_update": current_last_update,
                "details": details,
            })

        for change in position_changes:
            action = change["change_type"]
            bgp_info(
                "live_order_status_poller",
                "position_execution_changed",
                executor_id=executor_id,
                order_id=order_id,
                action=action,
                position_id=change.get("position_id"),
                previous=change.get("previous"),
                current=change.get("position"),
            )
            position = change.get("position") or {}
            details = {
                "executor_id": executor_id,
                "source": "live_order_status_poller",
                "position_id": change.get("position_id"),
                "state": position.get("state"),
                "remaining_units": position.get("remaining_units"),
                "symbol": position.get("symbol") or asset.get("symbol"),
                "token": position.get("instrument_id") or asset.get("instrumentId"),
                "last_update": current_last_update,
                "previous": change.get("previous"),
            }
            store.log_event(order_id, action, details)
            self._broadcast({
                "type": "position_status_update",
                "action": action,
                "executor_id": executor_id,
                "order_id": order_id,
                "position_id": change.get("position_id"),
                "last_update": current_last_update,
                "details": details,
            })

    def _broadcast(self, message: dict[str, Any]) -> None:
        self.engine._on_engine_event(message)

    async def _handle_fulfilled(self, job: dict[str, Any], lookup: dict[str, Any]) -> None:
        executor_id = str(job["executor_id"])
        order_id = str(job["order_id"])
        store = self.engine.db_writer
        store.set_order_poll_job_status(
            executor_id,
            order_id,
            "FULFILLED",
            fulfillment_reason="order_fulfilled",
            lookup=lookup,
        )
        store.log_event(
            order_id,
            "ORDER_FILLED",
            {
                "executor_id": executor_id,
                "source": "live_order_status_poller",
                "lookup": lookup,
            },
        )
        self._broadcast({
            "type": "order",
            "action": "ORDER_FILLED",
            "executor_id": executor_id,
            "order_id": order_id,
            "details": {"source": "live_order_status_poller"},
        })
        await self._stop_executor(executor_id, reason="order_fulfilled")
        logger.info(
            "[OrderPoll] Order fulfilled executor=%s order=%s; strategy stopped",
            executor_id,
            order_id,
        )

    async def _handle_rejected(self, job: dict[str, Any], lookup: dict[str, Any]) -> None:
        executor_id = str(job["executor_id"])
        order_id = str(job["order_id"])
        store = self.engine.db_writer
        store.set_order_poll_job_status(
            executor_id,
            order_id,
            "REJECTED",
            fulfillment_reason="order_rejected",
            lookup=lookup,
        )
        store.log_event(
            order_id,
            "ORDER_REJECTED",
            {
                "executor_id": executor_id,
                "source": "live_order_status_poller",
                "lookup": lookup,
            },
        )
        self._broadcast({
            "type": "order",
            "action": "ORDER_REJECTED",
            "executor_id": executor_id,
            "order_id": order_id,
            "details": {"source": "live_order_status_poller"},
        })
        await self._stop_executor(executor_id, reason="order_rejected")
        status = lookup.get("status") or {}
        logger.warning(
            "[OrderPoll] Order rejected executor=%s order=%s status=%s lookup=%s; strategy stopped",
            executor_id,
            order_id,
            json.dumps(status, default=str, sort_keys=True),
            json.dumps(lookup, default=str, sort_keys=True),
        )

    async def _stop_executor(self, executor_id: str, *, reason: str) -> None:
        if executor_id not in self.engine.executors:
            logger.warning(
                "[OrderPoll] Executor %s not active on this engine; leaving job terminal in DB",
                executor_id,
            )
            return
        await self.engine.stop_executor(executor_id, reason=reason)
