from datetime import datetime, timezone
from unittest.mock import MagicMock

from control_plane.execution_scheduler import ExecutionScheduler, parse_utc_datetime


def test_parse_utc_datetime():
    parsed = parse_utc_datetime("2026-05-25T03:45:00+00:00")
    assert parsed == datetime(2026, 5, 25, 3, 45, tzinfo=timezone.utc)


def test_register_and_unregister_job():
    start_fn = MagicMock()
    scheduler = ExecutionScheduler(start_fn)
    scheduler.start()
    try:
        run_at = datetime(2099, 1, 5, 3, 45, tzinfo=timezone.utc)
        scheduler.register("exec-1", run_at)
        assert scheduler._scheduler.get_job("controlled-execution:exec-1") is not None
        scheduler.unregister("exec-1")
        assert scheduler._scheduler.get_job("controlled-execution:exec-1") is None
    finally:
        scheduler.shutdown()
