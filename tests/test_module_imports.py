"""Smoke-test that every repo module imports without NameError/ImportError."""

from __future__ import annotations

import importlib
import sys

import pytest

from tests.import_harness import discover_importable_modules

IMPORTABLE_MODULES = discover_importable_modules()


@pytest.mark.parametrize("module_name", IMPORTABLE_MODULES)
def test_repo_module_imports(module_name: str) -> None:
    module = importlib.import_module(module_name)
    assert module is not None


@pytest.mark.parametrize(
    "module_name",
    [
        "api.cursor_agent",
        "api.cursor_sdk_bridge",
        "api.ai_research_routes",
        "api.control_plane_mcp_tools",
        "control_plane.execution_source_links",
        "control_plane.ai_research_store",
        "event.telegram_cursor_agent",
    ],
)
def test_critical_modules_import_twice_without_error(module_name: str) -> None:
    sys.modules.pop(module_name, None)
    first = importlib.import_module(module_name)
    second = importlib.import_module(module_name)
    assert first is second
