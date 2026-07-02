from control_plane.agent_monitor import (
    AgentMonitorEvent,
    AgentMonitorQueue,
    build_client_monitor_prompt,
    build_monitor_flush_prompt,
    summarize_client_monitor_context,
    summarize_monitor_batch_events,
    MAX_QUEUE_AGE_SEC,
    MAX_QUEUE_ITEMS,
)


def test_queue_flushes_at_max_items():
    queue = AgentMonitorQueue(max_items=3, max_age_sec=600)
    assert not queue.enqueue(AgentMonitorEvent(kind="news", payload={"n": 1}))
    assert not queue.enqueue(AgentMonitorEvent(kind="news", payload={"n": 2}))
    assert queue.enqueue(AgentMonitorEvent(kind="news", payload={"n": 3}))
    assert queue.size == 3
    drained = queue.drain()
    assert len(drained) == 3
    assert queue.size == 0


def test_queue_flush_prompt_includes_kinds():
    focus = {"symbol": "LRCX", "broker": "etoro", "close_price": 425}
    events = [
        AgentMonitorEvent(kind="news", payload={"headline": "Test"}),
        AgentMonitorEvent(kind="stock_stats", payload={"move_pct": 1.2}),
    ]
    prompt = build_monitor_flush_prompt(focus, events)
    assert "LRCX" in prompt
    assert "news" in prompt
    assert "stock_stats" in prompt
    assert "Monitor batch" in prompt


def test_build_status_includes_queue_timing_fields():
    from control_plane.agent_monitor import AgentMonitorService, AgentMonitorEvent, _ThreadMonitor, AgentMonitorQueue

    service = AgentMonitorService()
    row = _ThreadMonitor(thread_id="thread-14", queue=AgentMonitorQueue(max_items=100, max_age_sec=600), focus_key="LRCX|etoro")
    row.queue.enqueue(AgentMonitorEvent(kind="news", payload={"h": 1}))
    status = service._build_status("thread-14", row, {"monitor_state": "active"})
    assert status["thread_id"] == "thread-14"
    assert status["queue_size"] == 1
    assert status["queue_max_items"] == 100
    assert status["job_state"] == "running"
    assert status["flush_at"] is not None


def test_queue_defaults_match_env_docs():
    assert MAX_QUEUE_ITEMS == 100
    assert MAX_QUEUE_AGE_SEC == 600


def test_summarize_monitor_batch_events():
    events = [
        AgentMonitorEvent(kind="news", payload={"headline": "Chip demand rises"}),
        AgentMonitorEvent(kind="news", payload={"headline": "Fab output up"}),
        AgentMonitorEvent(
            kind="stock_stats",
            payload={"window_minutes": 10, "move_pct": -0.32, "bars": 10},
        ),
        AgentMonitorEvent(
            kind="market_context",
            payload={"headlines": [{"title": "Markets steady"}], "indices": ["SPY", "QQQ"]},
        ),
        AgentMonitorEvent(kind="portfolio", payload={"open_positions": [], "actions": [{"title": "LRCX"}]}),
    ]
    items = summarize_monitor_batch_events(events)
    by_kind = {row["kind"]: row for row in items}
    assert by_kind["news"]["count"] == 2
    assert len(by_kind["news"]["samples"]) == 2
    assert by_kind["stock_stats"]["detail"] == "10m window · -0.32% move"
    assert by_kind["market_context"]["count"] == 1
    assert by_kind["portfolio"]["detail"] == "1 strategy action(s)"
