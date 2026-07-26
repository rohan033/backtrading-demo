"""Adapt AgenticSessionStore to the trading-session agent streaming API.

Agentic sessions use one-line thinking summaries only — no token spam, no A2UI.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from control_plane.agentic.snapshot import SessionSnapshot

_LIFECYCLE_STATUS_NOISE = frozenset({
    "running",
    "finished",
    "started",
    "complete",
    "completed",
    "done",
    "idle",
})

_REPO_THINKING_RE = re.compile(
    r"\b(repo(sitory)?|codebase|orchestrator\.py|grep|read file|source code|implementation)\b",
    re.I,
)


def _is_lifecycle_noise(message: str) -> bool:
    return message.strip().lower() in _LIFECYCLE_STATUS_NOISE


def _strip_thinking_lifecycle_noise(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned or _is_lifecycle_noise(cleaned):
        return ""
    if cleaned.upper().startswith("RUNNING") and len(cleaned) > 7 and cleaned[7].isalpha():
        cleaned = cleaned[7:].lstrip()
    if cleaned.upper().endswith("FINISHED") and len(cleaned) > 8:
        cleaned = cleaned[:-8].rstrip()
    return cleaned


def _one_line(text: str, *, max_len: int = 180) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if not cleaned:
        return ""
    if len(cleaned) <= max_len:
        return cleaned
    cut = cleaned[: max_len - 1]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip() + "…"


def _first_sentence(text: str) -> str:
    line = _one_line(text, max_len=500)
    if not line:
        return ""
    match = re.split(r"(?<=[.!?])\s+", line, maxsplit=1)
    return _one_line(match[0] if match else line)


def _tool_summary(payload: dict[str, Any]) -> str:
    raw_name = str(payload.get("tool_name") or "tool")
    name = raw_name.rsplit(".", 1)[-1].replace("_", " ")
    detail = str(payload.get("detail") or payload.get("args") or "")
    symbols: list[str] = []
    if detail.startswith("{"):
        try:
            blob = json.loads(detail)
            for key in ("symbol", "ticker", "symbols", "instrumentIds"):
                val = blob.get(key)
                if isinstance(val, str) and val.strip():
                    symbols.append(val.strip().upper())
                elif isinstance(val, list):
                    symbols.extend(str(v).upper() for v in val[:3] if v)
        except json.JSONDecodeError:
            pass
    if not symbols:
        for token in re.findall(r"\b[A-Z]{2,5}\b", detail.upper()):
            if token not in {"JSON", "TRUE", "FALSE", "NULL"}:
                symbols.append(token)
                break
    if symbols:
        return _one_line(f"{name} → {', '.join(symbols[:3])}")
    return _one_line(f"Calling {name}…")


class AgenticAgentStoreAdapter:
    """Maps append_event → add_event; buffers stream tokens into one-line summaries."""

    STREAM_FLUSH_SECONDS = 0.5
    STREAM_FLUSH_CHARS = 48

    def __init__(self, store: Any, *, agent: str = "session", suppress_thinking_stream: bool = False):
        self._store = store
        self._agent = agent
        self._suppress_thinking_stream = suppress_thinking_stream
        self._stream_buffers: dict[str, str] = {}
        self._run_final_text: dict[str, str] = {}
        # Live thinking token streaming into the snapshot (throttled writes).
        self._pending_tokens: dict[str, str] = {}
        self._last_flush: dict[str, float] = {}

    def _snapshot(self, session_id: str) -> SessionSnapshot:
        return SessionSnapshot(self._store, session_id)

    def _stream_tokens(
        self, session_id: str, run_id: str | None, token: str, *, force: bool = False
    ) -> None:
        """Throttled append of streaming thinking tokens into the snapshot buffer."""
        if not run_id:
            return
        key = self._buffer_key(session_id, run_id)
        self._pending_tokens[key] = self._pending_tokens.get(key, "") + token
        now = time.monotonic()
        last = self._last_flush.get(key, 0.0)
        pending = self._pending_tokens.get(key, "")
        if not force and now - last < self.STREAM_FLUSH_SECONDS and len(pending) < self.STREAM_FLUSH_CHARS:
            return
        if not pending:
            return
        try:
            self._snapshot(session_id).append_thinking(
                run_id, agent=self._agent, token=pending
            )
        except Exception:
            return
        self._pending_tokens[key] = ""
        self._last_flush[key] = now

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        session = self._store.get_session(session_id)
        if not session:
            return None
        row = dict(session)
        row["state"] = row.get("status") or "running"
        return row

    def _buffer_key(self, session_id: str, run_id: str | None) -> str:
        return f"{session_id}:{run_id or 'default'}"

    def _flush_buffer(
        self,
        session_id: str,
        run_id: str | None,
        *,
        ticker: str | None = None,
    ) -> dict[str, Any]:
        key = self._buffer_key(session_id, run_id)
        raw = self._stream_buffers.pop(key, "")
        summary = _first_sentence(raw)
        if not summary:
            return {}
        return self._store.add_event(
            session_id,
            "thinking",
            summary,
            ticker=ticker,
            meta={"agent": self._agent, "run_id": run_id, "kind": "summary"},
        )

    def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        payload = payload if isinstance(payload, dict) else {}
        agent = str(payload.get("agent") or self._agent)
        run_id = payload.get("run_id")

        if event_type in {"agent_a2ui_surface", "agent_run_started"}:
            return {}

        if event_type == "agent_thinking":
            message = str(payload.get("message") or "")
            if not message or _is_lifecycle_noise(message) or _REPO_THINKING_RE.search(message):
                return {}
            if self._suppress_thinking_stream:
                return {}
            key = self._buffer_key(session_id, run_id)
            self._stream_buffers[key] = self._stream_buffers.get(key, "") + message
            # Stream the raw tokens into the snapshot thinking block (plain text only).
            self._stream_tokens(session_id, run_id, message)
            return {}

        if event_type == "agent_tool_call":
            if self._suppress_thinking_stream:
                return {}
            summary = _tool_summary({**payload, "agent": agent})
            if not summary:
                return {}
            return self._store.add_event(
                session_id,
                "thinking",
                summary,
                meta={"agent": agent, "kind": "tool", "run_id": run_id},
            )

        if event_type == "agent_text":
            text = str(payload.get("text") or "").strip()
            key = self._buffer_key(session_id, run_id)
            buffered = self._stream_buffers.get(key, "")
            combined = text or buffered
            if combined:
                self._run_final_text[key] = combined
            summary = _first_sentence(combined)
            if not summary:
                return {}
            return self._store.add_event(
                session_id,
                "thinking",
                summary,
                meta={**payload, "agent": agent, "kind": "summary", "run_id": run_id},
            )

        if event_type == "agent_run_finished":
            # Finalize the live thinking block (flush any buffered tokens).
            if run_id:
                key = self._buffer_key(session_id, run_id)
                pending = self._pending_tokens.pop(key, "")
                self._last_flush.pop(key, None)
                if pending:
                    try:
                        self._snapshot(session_id).append_thinking(
                            run_id, agent=agent, token=pending
                        )
                    except Exception:
                        pass
                buffered = self._stream_buffers.pop(key, "")
                full_text = _strip_thinking_lifecycle_noise(
                    self._run_final_text.pop(key, "") or buffered
                )
                summary = _one_line(full_text)
                try:
                    self._snapshot(session_id).finish_thinking(
                        run_id,
                        oneline=summary,
                        text=full_text,
                    )
                except Exception:
                    pass
            flushed = self._flush_buffer(session_id, run_id)
            if flushed:
                return flushed
            ok = payload.get("ok", True)
            if ok is False and payload.get("error"):
                return self._store.add_event(
                    session_id,
                    "thinking",
                    _one_line(f"Agent stopped: {payload.get('error')}"),
                    meta={"agent": agent, "kind": "error", "run_id": run_id},
                )
            return {}

        if event_type.startswith("agent_"):
            return {}

        return self._store.add_event(
            session_id,
            "info",
            _one_line(event_type),
            meta={**payload, "agent": agent},
        )

    def list_events(
        self,
        session_id: str,
        *,
        since_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        return self._store.list_events(session_id, after_id=since_id, limit=limit)
