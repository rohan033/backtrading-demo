"""Single source for repository and runtime paths."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = REPO_ROOT / "src"
AGENTIC_SKILLS_DIR = Path(__file__).resolve().parent / "agentic" / "skills"


def live_events_db_path() -> Path:
    raw = os.getenv("LIVE_EVENTS_DB", "live_events.db")
    p = Path(raw)
    return p if p.is_absolute() else REPO_ROOT / p
