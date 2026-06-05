from pathlib import Path

from api.workspace_media import (
    attachments_from_paths,
    extract_media_attachments,
    extract_media_paths_from_text,
    resolve_workspace_media_path,
)
from control_plane.engine_process_manager import REPO_ROOT


def test_resolve_workspace_media_path_relative(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setattr("api.workspace_media.REPO_ROOT", root)
    chart = root / "charts" / "sample.png"
    chart.parent.mkdir(parents=True)
    chart.write_bytes(b"\x89PNG\r\n")

    resolved = resolve_workspace_media_path("charts/sample.png")
    assert resolved == chart


def test_resolve_workspace_media_path_blocks_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr("api.workspace_media.REPO_ROOT", tmp_path)
    outside = tmp_path.parent / "outside.png"
    outside.write_bytes(b"\x89PNG\r\n")

    assert resolve_workspace_media_path(str(outside)) is None


def test_extract_media_paths_from_markdown(tmp_path, monkeypatch):
    monkeypatch.setattr("api.workspace_media.REPO_ROOT", tmp_path)
    chart = tmp_path / "mnts_chart.png"
    chart.write_bytes(b"\x89PNG\r\n")

    paths = extract_media_paths_from_text("See ![chart](mnts_chart.png) for levels.")
    assert paths == ["mnts_chart.png"]


def test_attachments_from_paths(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setattr("api.workspace_media.REPO_ROOT", root)
    gif = root / "loop.gif"
    gif.write_bytes(b"GIF89a")

    rows = attachments_from_paths(["loop.gif"])
    assert rows == [{"path": "loop.gif", "kind": "animation", "label": "loop.gif"}]


def test_extract_media_attachments_dedupes():
    text = "![a](mnts_chart.png) and mnts_chart.png again"
    # Only run if fixture exists in repo (optional integration-style)
    if not (REPO_ROOT / "mnts_chart.png").is_file():
        return
    rows = extract_media_attachments(text)
    assert len(rows) == 1
    assert rows[0]["path"] == "mnts_chart.png"
