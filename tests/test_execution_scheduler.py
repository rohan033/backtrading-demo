from datetime import datetime, timezone
from unittest.mock import MagicMock

from control_plane.execution_scheduler import ExecutionScheduler, parse_utc_datetime


def test_parse_utc_datetime():
    parsed = parse_utc_datetime("2026-05-25T03:45:00+00:00")
    assert parsed == datetime(2026, 5, 25, 3, 45, tzinfo=timezone.utc)


def test_due_execution_ids_only_includes_past_scheduled():
    now = datetime(2026, 5, 27, 9, 30, tzinfo=timezone.utc)

    def list_engines(status=None):
        assert status == "scheduled"
        return [
            {
                "id": "due-exec",
                "status": "scheduled",
                "metadata": {"scheduled_start_at": "2020-01-01T09:15:00+00:00"},
            },
            {
                "id": "future-exec",
                "status": "scheduled",
                "metadata": {"scheduled_start_at": "2099-01-01T09:15:00+00:00"},
            },
            {
                "id": "missing-time",
                "status": "scheduled",
                "metadata": {},
            },
        ]

    scheduler = ExecutionScheduler(list_engines, MagicMock())
    assert scheduler.due_execution_ids(now=now) == ["due-exec"]


def test_poll_once_starts_due_executions():
    now = datetime(2026, 5, 27, 9, 30, tzinfo=timezone.utc)
    start_fn = MagicMock()

    def list_engines(status=None):
        return [
            {
                "id": "due-exec",
                "status": "scheduled",
                "metadata": {"scheduled_start_at": "2020-01-01T09:15:00+00:00"},
            }
        ]

    scheduler = ExecutionScheduler(list_engines, start_fn)
    started = scheduler.poll_once()
    assert started == ["due-exec"]
    start_fn.assert_called_once_with("due-exec")


def test_poll_once_skips_when_nothing_due():
    start_fn = MagicMock()

    def list_engines(status=None):
        return [
            {
                "id": "future-exec",
                "status": "scheduled",
                "metadata": {"scheduled_start_at": "2099-01-01T09:15:00+00:00"},
            }
        ]

    scheduler = ExecutionScheduler(list_engines, start_fn)
    assert scheduler.due_execution_ids(
        now=datetime(2026, 5, 27, 8, 0, tzinfo=timezone.utc),
    ) == []
    started = scheduler.poll_once()
    assert started == []
    start_fn.assert_not_called()
