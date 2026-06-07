import os
import tempfile

from event.db_event_consumer import DbEventWriter


def test_order_poll_job_persists_and_resumes_running_status():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = DbEventWriter(db_path=os.path.join(tmpdir, "events.db"))
        store.log_event(
            "123",
            "BUY_ORDER_PLACED",
            {"executor_id": "exec-1", "symbol": "AAPL"},
        )
        store.upsert_order_poll_job(
            executor_id="exec-1",
            order_id="123",
            account_env="demo",
            engine_id="engine-1",
            status="RUNNING",
        )
        store.set_order_poll_job_status("exec-1", "123", "STOPPED")
        store.ensure_order_poll_job_running("123")

        job = store.get_order_poll_job("exec-1", "123")
        assert job is not None
        assert job["status"] == "RUNNING"
        assert store.get_executor_id_for_order("123") == "exec-1"

        running = store.list_order_poll_jobs(status="RUNNING")
        assert len(running) == 1
