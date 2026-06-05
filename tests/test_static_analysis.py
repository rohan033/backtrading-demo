"""Static checks that catch missing imports and undefined names before runtime."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from tests.conftest import REPO_ROOT
from tests.import_harness import discover_python_files

RUFF_SCAN_ROOTS = (
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


def _ruff_check(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "ruff", "check", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_repo_has_no_undefined_names() -> None:
    result = _ruff_check(*RUFF_SCAN_ROOTS, "--select", "F821")
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("scan_root", RUFF_SCAN_ROOTS)
def test_package_tree_has_no_undefined_names(scan_root: str) -> None:
    root = REPO_ROOT / scan_root
    if not root.exists():
        pytest.skip(f"missing scan root: {scan_root}")
    result = _ruff_check(scan_root, "--select", "F821")
    assert result.returncode == 0, f"{scan_root}:\n{result.stdout}{result.stderr}"


@pytest.mark.parametrize("py_file", discover_python_files(), ids=lambda p: p.relative_to(REPO_ROOT).as_posix())
def test_python_file_has_no_undefined_names(py_file: Path) -> None:
    rel = py_file.relative_to(REPO_ROOT).as_posix()
    result = _ruff_check(rel, "--select", "F821")
    assert result.returncode == 0, f"{rel}:\n{result.stdout}{result.stderr}"
