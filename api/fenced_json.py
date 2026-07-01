"""Parse JSON objects inside markdown code fences (```json / ```a2ui / ```)."""

from __future__ import annotations

import json
import re
from typing import Any, Iterator

FENCE_START_RE = re.compile(r"```(?:json|a2ui)?\s*", re.MULTILINE | re.IGNORECASE)


def iter_fenced_json_blocks(text: str) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (full_fence_match, parsed_json) for fenced JSON blocks."""
    for start_match in FENCE_START_RE.finditer(text):
        body_start = start_match.end()
        end_idx = text.find("```", body_start)
        if end_idx == -1:
            continue
        raw = text[body_start:end_idx].strip()
        if not raw.startswith("{"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        full_match = text[start_match.start():end_idx + 3]
        yield full_match, payload
