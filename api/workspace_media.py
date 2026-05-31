"""Serve workspace image/chart/animation files to the UI with path traversal protection."""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from control_plane.engine_process_manager import REPO_ROOT

router = APIRouter(prefix="/api/workspace", tags=["workspace-media"])

MEDIA_EXTENSIONS = frozenset({
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".webm",
    ".mp4",
    ".apng",
})

MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
MEDIA_PATH_RE = re.compile(
    r"(?:^|[\s`\"'(])([^\s`\"')]+\.(?:png|jpe?g|gif|webp|svg|webm|mp4|apng))",
    re.IGNORECASE,
)


def media_kind_for_suffix(suffix: str) -> str:
    lowered = suffix.lower()
    if lowered in {".gif", ".webp", ".apng"}:
        return "animation"
    if lowered in {".webm", ".mp4"}:
        return "video"
    return "image"


def resolve_workspace_media_path(raw: str) -> Path | None:
    """Resolve a repo-relative or absolute-in-repo path to a readable file."""
    text = (raw or "").strip().strip("'\"")
    if not text or text.startswith(("http://", "https://", "data:")):
        return None

    candidate = Path(text)
    if not candidate.is_absolute():
        candidate = (REPO_ROOT / candidate).resolve()
    else:
        candidate = candidate.resolve()

    try:
        candidate.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return None

    if not candidate.is_file():
        return None
    if candidate.suffix.lower() not in MEDIA_EXTENSIONS:
        return None
    return candidate


def extract_media_paths_from_text(text: str) -> list[str]:
    """Find workspace media paths referenced in markdown or plain text."""
    if not text:
        return []

    found: list[str] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        cleaned = raw.strip().strip("'\"")
        if not cleaned or cleaned in seen:
            return
        resolved = resolve_workspace_media_path(cleaned)
        if resolved is None:
            return
        try:
            rel = resolved.relative_to(REPO_ROOT.resolve()).as_posix()
        except ValueError:
            return
        seen.add(cleaned)
        seen.add(rel)
        found.append(rel)

    for match in MARKDOWN_IMAGE_RE.finditer(text):
        add(match.group(1))

    for match in MEDIA_PATH_RE.finditer(text):
        add(match.group(1))

    return found


def attachments_from_paths(paths: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in paths:
        resolved = resolve_workspace_media_path(raw)
        if resolved is None:
            continue
        rel = resolved.relative_to(REPO_ROOT.resolve()).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        rows.append({
            "path": rel,
            "kind": media_kind_for_suffix(resolved.suffix),
            "label": resolved.name,
        })
    return rows


def extract_media_attachments(text: str) -> list[dict[str, Any]]:
    return attachments_from_paths(extract_media_paths_from_text(text))


@router.get("/media/{file_path:path}")
async def get_workspace_media(file_path: str):
    resolved = resolve_workspace_media_path(file_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Media file not found")
    media_type, _ = mimetypes.guess_type(resolved.name)
    return FileResponse(
        resolved,
        media_type=media_type or "application/octet-stream",
        filename=resolved.name,
    )
