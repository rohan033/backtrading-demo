"""Forward control-plane requests to a running live engine."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def forward_live_json(
    api_base_url: str,
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    url = f"{api_base_url.rstrip('/')}{path}"
    payload = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {"status": True}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
        except json.JSONDecodeError:
            parsed = {"detail": detail or exc.reason}
        parsed["status"] = False
        parsed["http_status"] = exc.code
        return parsed
    except Exception as exc:
        return {"status": False, "detail": str(exc)}
