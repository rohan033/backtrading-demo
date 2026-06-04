"""Incremental engine log streaming for the control plane."""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator

from control_plane.engine_registry import EngineRegistry
from control_plane.ops_logging import REPO_ROOT, live_engine_log_path

ALLOWED_LOG_ROOT = (REPO_ROOT / "logs").resolve()
DEFAULT_CHUNK_LINES = int(os.getenv("ENGINE_LOG_CHUNK_LINES", "120"))
DEFAULT_POLL_SECONDS = float(os.getenv("ENGINE_LOG_TAIL_POLL_SECONDS", "1.0"))
MAX_LINE_CHARS = int(os.getenv("ENGINE_LOG_MAX_LINE_CHARS", "4000"))

ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")


def resolve_engine_log_path(registry: EngineRegistry, engine_id: str) -> Path | None:
    engine = registry.get_engine(engine_id)
    candidates: list[Path] = []

    if engine:
        metadata = engine.get("metadata") or {}
        log_file = metadata.get("log_file")
        if log_file:
            candidates.append(Path(str(log_file)))

    candidates.append(live_engine_log_path(engine_id))

    for candidate in candidates:
        safe = safe_log_path(candidate)
        if safe is not None:
            return safe
    return None


def safe_log_path(path: Path) -> Path | None:
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return None

    if resolved == ALLOWED_LOG_ROOT or ALLOWED_LOG_ROOT in resolved.parents:
        return resolved
    return None


def sanitize_log_line(raw: str) -> str:
    line = ANSI_ESCAPE_RE.sub("", raw.rstrip("\r\n"))
    if len(line) > MAX_LINE_CHARS:
        return f"{line[:MAX_LINE_CHARS]}…"
    return line


def _read_line_batch(path: Path, *, byte_offset: int, max_lines: int) -> tuple[list[str], int, int]:
    lines: list[str] = []
    file_size = path.stat().st_size
    if byte_offset > file_size:
        byte_offset = file_size

    with path.open("rb") as handle:
        handle.seek(byte_offset)
        pending = b""
        while len(lines) < max_lines:
            chunk = handle.read(65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending and len(lines) < max_lines:
                raw_line, pending = pending.split(b"\n", 1)
                try:
                    decoded = raw_line.decode("utf-8", errors="replace")
                except UnicodeDecodeError:
                    decoded = raw_line.decode("latin-1", errors="replace")
                lines.append(sanitize_log_line(decoded))

        if len(lines) < max_lines and pending and byte_offset + len(pending) >= file_size:
            try:
                decoded = pending.decode("utf-8", errors="replace")
            except UnicodeDecodeError:
                decoded = pending.decode("latin-1", errors="replace")
            if decoded:
                lines.append(sanitize_log_line(decoded))
            pending = b""

        next_offset = handle.tell() - len(pending)

    return lines, next_offset, file_size


async def stream_engine_log_events(
    path: Path,
    *,
    chunk_lines: int = DEFAULT_CHUNK_LINES,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    wait_for_file_seconds: float = 30.0,
) -> AsyncIterator[dict[str, Any]]:
    deadline = asyncio.get_running_loop().time() + wait_for_file_seconds
    while not path.exists():
        if asyncio.get_running_loop().time() >= deadline:
            yield {"type": "error", "message": f"Log file not found: {path.name}"}
            return
        yield {"type": "waiting", "message": "Waiting for log file…"}
        await asyncio.sleep(min(poll_seconds, 1.0))

    byte_offset = 0
    total_lines = 0
    stat_result = await asyncio.to_thread(path.stat)
    file_size = stat_result.st_size

    yield {
        "type": "meta",
        "path": str(path),
        "size": file_size,
        "exists": True,
    }

    caught_up = False
    while True:
        if not path.exists():
            yield {"type": "error", "message": "Log file disappeared"}
            return

        lines, byte_offset, file_size = await asyncio.to_thread(
            _read_line_batch,
            path,
            byte_offset=byte_offset,
            max_lines=chunk_lines,
        )

        if lines:
            total_lines += len(lines)
            yield {
                "type": "chunk" if not caught_up else "tail",
                "lines": lines,
                "offset": byte_offset,
                "size": file_size,
                "line_count": total_lines,
            }
            await asyncio.sleep(0)
            continue

        if byte_offset >= file_size:
            if not caught_up:
                caught_up = True
                yield {"type": "caught_up", "line_count": total_lines, "size": file_size}
            await asyncio.sleep(poll_seconds)
            try:
                file_size = (await asyncio.to_thread(path.stat)).st_size
            except OSError:
                yield {"type": "error", "message": "Unable to read log file"}
                return
            continue

        await asyncio.sleep(poll_seconds)


def sse_encode(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, default=str)}\n\n"
