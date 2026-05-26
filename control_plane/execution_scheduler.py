from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Callable

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger

log = logging.getLogger("backtrading")

StartExecutionFn = Callable[[str], None]


def parse_utc_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class ExecutionScheduler:
    """APScheduler-backed one-shot jobs for controlled execution starts."""

    def __init__(self, start_execution_fn: StartExecutionFn):
        self._start_execution = start_execution_fn
        self._scheduler = BackgroundScheduler(timezone="UTC")

    @staticmethod
    def job_id(execution_id: str) -> str:
        return f"controlled-execution:{execution_id}"

    @property
    def running(self) -> bool:
        return bool(self._scheduler.running)

    def start(self) -> None:
        if self._scheduler.running:
            return
        self._scheduler.start()
        log.info("[SCHEDULER] APScheduler started")

    def shutdown(self) -> None:
        if not self._scheduler.running:
            return
        self._scheduler.shutdown(wait=False)
        log.info("[SCHEDULER] APScheduler stopped")

    def register(self, execution_id: str, scheduled_start_at: datetime) -> None:
        self.unregister(execution_id)
        now = datetime.now(timezone.utc)
        run_date = scheduled_start_at if scheduled_start_at > now else now + timedelta(seconds=2)
        self._scheduler.add_job(
            self._run_start,
            trigger=DateTrigger(run_date=run_date),
            id=self.job_id(execution_id),
            args=[execution_id],
            replace_existing=True,
            misfire_grace_time=3600,
        )
        log.info(
            "[SCHEDULER] Registered execution %s for %s",
            execution_id,
            run_date.isoformat(),
        )

    def unregister(self, execution_id: str) -> None:
        job_id = self.job_id(execution_id)
        if self._scheduler.get_job(job_id):
            self._scheduler.remove_job(job_id)
            log.info("[SCHEDULER] Removed job for execution %s", execution_id)

    def sync_registry(self, engines: list[dict]) -> None:
        active_ids: set[str] = set()
        for engine in engines:
            if str(engine.get("status") or "").lower() != "scheduled":
                continue
            execution_id = engine.get("id")
            metadata = engine.get("metadata") or {}
            scheduled_at = parse_utc_datetime(metadata.get("scheduled_start_at"))
            if not execution_id or not scheduled_at:
                continue
            self.register(execution_id, scheduled_at)
            active_ids.add(execution_id)

        for job in self._scheduler.get_jobs():
            if not str(job.id).startswith("controlled-execution:"):
                continue
            execution_id = str(job.id).split(":", 1)[1]
            if execution_id not in active_ids:
                self.unregister(execution_id)

        log.info("[SCHEDULER] Synced %d scheduled execution job(s)", len(active_ids))

    def _run_start(self, execution_id: str) -> None:
        log.info("[SCHEDULER] Firing scheduled start for %s", execution_id)
        try:
            self._start_execution(execution_id)
        except Exception as exc:
            log.error(
                "[SCHEDULER] Failed to start scheduled execution %s: %s",
                execution_id,
                exc,
                exc_info=True,
            )
