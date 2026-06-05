"""Discover importable Python modules under the repo for smoke tests."""

from __future__ import annotations

from pathlib import Path

from tests.conftest import REPO_ROOT

SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        "site",
        "frontend",
        "examples",
        "node_modules",
        ".pytest_cache",
        "logs",
    }
)
SKIP_FILE_NAMES = frozenset({"test.py", "testing.py", "temp.py"})
SKIP_TOP_LEVEL = frozenset({"tests"})
# Legacy top-level scripts that execute side effects on import.
SKIP_LEGACY_ROOT_MODULES = frozenset(
    {
        "main",
        "client",
        "backtesting",
        "strategy",
        "order",
        "tick",
        "config",
        "utils",
    }
)


def _module_name(path: Path) -> str:
    rel = path.relative_to(REPO_ROOT)
    parts = list(rel.with_suffix("").parts)
    if parts[0] == "src" and len(parts) > 1 and parts[1] == "backtrading":
        parts = parts[1:]
    return ".".join(parts)


def discover_importable_modules() -> list[str]:
    modules: list[str] = []
    for path in sorted(REPO_ROOT.rglob("*.py")):
        rel = path.relative_to(REPO_ROOT)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if rel.parts[0] in SKIP_TOP_LEVEL:
            continue
        if any(part in SKIP_DIR_NAMES for part in rel.parts):
            continue
        if path.name in SKIP_FILE_NAMES:
            continue
        if rel.parts[0] == "scripts":
            continue
        module = _module_name(path)
        if len(rel.parts) == 1 and module in SKIP_LEGACY_ROOT_MODULES:
            continue
        modules.append(module)
    return modules


def discover_python_files() -> list[Path]:
    files: list[Path] = []
    scan_roots = (
        "api",
        "brokers",
        "control_plane",
        "event",
        "indicators",
        "managers",
        "manual_robo",
        "mcps",
        "strategies",
        "src/backtrading",
        "tests",
    )
    for root_name in scan_roots:
        root = REPO_ROOT / root_name
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.py")):
            if any(part in SKIP_DIR_NAMES for part in path.relative_to(REPO_ROOT).parts):
                continue
            if path.name in SKIP_FILE_NAMES:
                continue
            files.append(path)
    return files
