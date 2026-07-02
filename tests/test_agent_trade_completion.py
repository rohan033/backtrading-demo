from control_plane.agent_trade_completion import extract_trade_completions, record_trade_log


def test_extract_trade_completions():
    text = """
```json
{"ai_action":{"type":"trade_complete","title":"LRCX target","payload":{"symbol":"LRCX","outcome":"profit","pnl":210.5,"pnl_pct":4.2}}}
```
"""
    rows = extract_trade_completions(text)
    assert len(rows) == 1
    assert rows[0]["symbol"] == "LRCX"
    assert rows[0]["pnl"] == 210.5


def test_record_trade_log(tmp_path, monkeypatch):
    db_path = tmp_path / "control_plane.db"
    monkeypatch.setattr("control_plane.ai_research_store.DB_PATH", str(db_path))

    from control_plane.ai_research_store import AiResearchStore

    store = AiResearchStore()
    session = store.create_session(
        title="Agent",
        metadata={"product": "agent_mode", "focus": {"symbol": "LRCX", "broker": "etoro"}},
    )
    row = record_trade_log(session["session_id"], {
        "symbol": "LRCX",
        "outcome": "profit",
        "pnl": 100,
        "pnl_pct": 2.5,
        "reason": "Target hit",
    })
    assert row["pnl"] == 100
    listed = store.list_agent_trade_logs(session["session_id"])
    assert len(listed) == 1
    assert listed[0]["outcome"] == "profit"
