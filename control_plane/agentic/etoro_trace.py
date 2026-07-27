"""Per-session eToro Public API trace logs for agentic sessions (JSONL).

Tracing is opt-in via context: only HTTP calls made while an agentic
session trace context is active are written. Strategies, screeners, and
other subsystems that use EtoroClient without this context are unaffected.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
import time
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator

from control_plane.ops_logging import agentic_session_etoro_log_path

log = logging.getLogger("backtrading")

_trace_context: ContextVar[dict[str, Any] | None] = ContextVar(
    "agentic_etoro_trace_context", default=None
)

_file_lock = threading.Lock()

_SENSITIVE_HEADER_KEYS = frozenset(
    {
        "authorization",
        "x-api-key",
        "x-user-key",
    }
)

# Noisy market-data GETs — skipped unless AGENTIC_ETORO_TRACE_VERBOSE=1.
_QUIET_GET_PREFIXES = (
    "/market-data/instruments/rates",
    "/market-data/instruments",
    "/market-data/candles",
    "/market-data/historical-candles",
)


def _trace_verbose() -> bool:
    return os.getenv("AGENTIC_ETORO_TRACE_VERBOSE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def get_active_trace_context() -> dict[str, Any] | None:
    return _trace_context.get()


@contextlib.contextmanager
def agentic_etoro_trace(
    session_id: str,
    *,
    source: str | None = None,
    ticker: str | None = None,
    position_id: str | None = None,
    **extra: Any,
) -> Iterator[None]:
    """Mark subsequent eToro HTTP calls as belonging to this agentic session."""
    payload: dict[str, Any] = {
        "session_id": str(session_id),
        "source": source,
        "ticker": ticker,
        "position_id": position_id,
    }
    payload.update(extra)
    token = _trace_context.set(payload)
    try:
        yield
    finally:
        _trace_context.reset(token)


def _redact_headers(headers: dict[str, Any] | None) -> dict[str, Any]:
    if not headers:
        return {}
    out: dict[str, Any] = {}
    for key, value in headers.items():
        if str(key).lower() in _SENSITIVE_HEADER_KEYS:
            out[key] = "[redacted]"
        else:
            out[key] = value
    return out


def _should_skip_trace(
    *,
    method: str,
    path: str,
    trade_execution: bool,
    error: BaseException | None,
) -> bool:
    if error is not None:
        return False
    if trade_execution:
        return False
    if _trace_verbose():
        return False
    upper = method.upper()
    if upper != "GET":
        return False
    normalized = path.split("?", 1)[0]
    return any(fragment in normalized for fragment in _QUIET_GET_PREFIXES)


def _summarize_response(response: Any, *, error: BaseException | None) -> Any:
    if error is not None:
        payload: dict[str, Any] = {"error": str(error)}
        if isinstance(error, Exception) and getattr(error, "payload", None) is not None:
            payload["payload"] = error.payload
        status_code = getattr(error, "status_code", None)
        if status_code is not None:
            payload["status_code"] = status_code
        return payload
    if isinstance(response, dict):
        if len(json.dumps(response, default=str)) > 12000:
            keys = list(response.keys())[:24]
            return {"_truncated": True, "keys": keys, "preview": {k: response[k] for k in keys[:6]}}
        return response
    if isinstance(response, list):
        return {"_list": True, "length": len(response)}
    return response


def record_etoro_call(
    *,
    method: str,
    path: str,
    params: dict[str, Any] | None,
    json_body: dict[str, Any] | list[Any] | None,
    headers: dict[str, Any] | None,
    response: Any,
    error: BaseException | None,
    duration_ms: float,
    trade_execution: bool,
    status_code: int | None = None,
) -> None:
    ctx = _trace_context.get()
    if not ctx or not ctx.get("session_id"):
        return
    if _should_skip_trace(
        method=method,
        path=path,
        trade_execution=trade_execution,
        error=error,
    ):
        return

    session_id = str(ctx["session_id"])
    record: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "source": ctx.get("source"),
        "ticker": ctx.get("ticker"),
        "position_id": ctx.get("position_id"),
        "request": {
            "method": method.upper(),
            "path": path,
            "params": params or {},
            "body": json_body,
            "headers": _redact_headers(headers),
        },
        "response": _summarize_response(response, error=error),
        "duration_ms": round(duration_ms, 2),
        "trade_execution": bool(trade_execution),
    }
    if status_code is not None:
        record["status_code"] = status_code
    context_extra = {
        key: value
        for key, value in ctx.items()
        if key not in record and key not in {"session_id", "source", "ticker", "position_id"}
    }
    if context_extra:
        record["context"] = context_extra

    line = json.dumps(record, default=str, ensure_ascii=False)
    log_path = agentic_session_etoro_log_path(session_id)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with _file_lock:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError as exc:
        log.debug("[AGENTIC_ETORO_TRACE] write failed session=%s: %s", session_id, exc)


def trace_call_start() -> float:
    return time.monotonic()
