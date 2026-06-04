from event.telegram_inbound import inbound_log_line


def test_inbound_log_line_text_message():
    line = inbound_log_line(
        {
            "update_id": 1,
            "message": {
                "message_id": 10,
                "from": {"id": 99, "username": "trader", "first_name": "A"},
                "chat": {"id": 99, "type": "private"},
                "text": "hello bot",
            },
        }
    )
    assert line is not None
    assert "chat_id=99" in line
    assert "from=trader" in line
    assert "'hello bot'" in line


def test_inbound_log_line_ignores_non_message():
    assert inbound_log_line({"update_id": 2, "callback_query": {}}) is None
