from api.ai_research_routes import extract_reply_summary, strip_ai_summary_blocks


def test_extract_reply_summary_from_json_fence():
    text = """Good setup.

```json
{"ai_summary":{"highlights":["Strong trend"],"lowlights":["Thin liquidity"],"cautions":["Not advice"]}}
```"""
    summary = extract_reply_summary(text)
    assert summary is not None
    assert summary["highlights"] == ["Strong trend"]
    assert summary["lowlights"] == ["Thin liquidity"]
    assert summary["cautions"] == ["Not advice"]


def test_strip_ai_summary_blocks_removes_fence():
    text = """Body text.

```json
{"ai_summary":{"highlights":["A"],"lowlights":[],"cautions":[]}}
```"""
    cleaned = strip_ai_summary_blocks(text)
    assert "ai_summary" not in cleaned
    assert "Body text." in cleaned
