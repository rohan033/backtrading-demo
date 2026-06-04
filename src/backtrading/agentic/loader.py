"""Universal skill loader (canonical: agentic/skills/<id>/SKILL.md)."""

from __future__ import annotations

import os
from pathlib import Path

from backtrading._paths import AGENTIC_SKILLS_DIR


class SkillSource:
    def __init__(self, root: Path | None = None) -> None:
        env = os.getenv("BACKTRADING_SKILLS_DIR")
        if env:
            self.root = Path(env)
        elif root is not None:
            self.root = root
        else:
            self.root = AGENTIC_SKILLS_DIR

    def load(self, skill_id: str) -> str:
        path = self.root / skill_id / "SKILL.md"
        if not path.is_file():
            raise FileNotFoundError(f"Skill not found: {skill_id} at {path}")
        return path.read_text(encoding="utf-8")

    def body_without_frontmatter(self, skill_id: str) -> str:
        raw = self.load(skill_id)
        if raw.startswith("---"):
            end = raw.find("---", 3)
            if end != -1:
                return raw[end + 3 :].lstrip()
        return raw


_default = SkillSource()


def load_skill(skill_id: str, *, strip_frontmatter: bool = True) -> str:
    if strip_frontmatter:
        return _default.body_without_frontmatter(skill_id)
    return _default.load(skill_id)
