from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Callable

log = logging.getLogger("backtrading")

StartExecutionFn = Callable[[str], None]
ListEnginesFn = Callable[..., list[dict]]


def parse_utc_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class ExecutionScheduler:
    """Polls the engine registry for due scheduled executions and starts them."""

    def __init__(self, list_engines_fn: ListEnginesFn, start_execution_fn: StartExecutionFn):
        self._list_engines = list_engines_fn
        self._start_execution = start_execution_fn

    def due_execution_ids(self, *, now: datetime | None = None) -> list[str]:
        current = now or datetime.now(timezone.utc)
        due: list[str] = []

        for engine in self._list_engines(status="scheduled"):
            execution_id = engine.get("id")
            metadata = engine.get("metadata") or {}
            scheduled_at = parse_utc_datetime(metadata.get("scheduled_start_at"))
            if not execution_id:
                continue
            if not scheduled_at:
                log.warning(
                    "[SCHEDULER] Scheduled execution %s has no scheduled_start_at; skipping",
                    execution_id,
                )
                continue
            if scheduled_at <= current:
                due.append(execution_id)

        return due

    def poll_once(self) -> list[str]:
        """Check DB for due scheduled strategies and fire starts. Returns started ids."""
        due_ids = self.due_execution_ids()
        if not due_ids:
            log.debug("[SCHEDULER] Poll complete — no due scheduled executions")
            return []

        started: list[str] = []
        for execution_id in due_ids:
            log.info("[SCHEDULER] Due scheduled execution %s — starting", execution_id)
            try:
                self._start_execution(execution_id)
                started.append(execution_id)
            except Exception as exc:
                log.error(
                    "[SCHEDULER] Failed to start scheduled execution %s: %s",
                    execution_id,
                    exc,
                    exc_info=True,
                )
        return started
