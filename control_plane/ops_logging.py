import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTROL_LOG_DIR = REPO_ROOT / "logs" / "control-plane"
DEFAULT_LIVE_LOG_DIR = REPO_ROOT / "logs" / "executions"

# Frontend poll endpoints (list refreshes) — noisy at INFO in uvicorn access logs.
_QUIET_POLL_GET_RE = re.compile(
    r'"GET /api/control/(?:engines|executions)(?:\?[^ ]*)? HTTP/',
    re.IGNORECASE,
)


class UvicornAccessPollFilter(logging.Filter):
    """Drop uvicorn access lines for high-frequency control-plane list GETs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if os.getenv("CONTROL_PLANE_LOG_POLL_GETS", "").strip().lower() in {"1", "true", "yes", "on"}:
            return True
        return _QUIET_POLL_GET_RE.search(record.getMessage()) is None


def quiet_uvicorn_poll_access_logs() -> None:
    access_logger = logging.getLogger("uvicorn.access")
    if any(isinstance(item, UvicornAccessPollFilter) for item in access_logger.filters):
        return
    access_logger.addFilter(UvicornAccessPollFilter())


def quiet_uvicorn_live_engine_access_logs() -> None:
    """Disable uvicorn HTTP access lines on data-plane engines (frontend poll noise)."""
    if os.getenv("LIVE_ENGINE_LOG_ACCESS", "").strip().lower() in {"1", "true", "yes", "on"}:
        return
    logging.getLogger("uvicorn.access").disabled = True


def _log_formatter() -> logging.Formatter:
    return logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _has_file_handler(logger: logging.Logger, log_path: Path) -> bool:
    resolved = str(log_path.resolve())
    return any(
        isinstance(handler, logging.FileHandler)
        and str(Path(handler.baseFilename).resolve()) == resolved
        for handler in logger.handlers
    )


def configure_control_plane_logging(
    log_dir: Path | None = None,
    log_name: str = "control-plane.log",
    max_bytes: int = 5 * 1024 * 1024,
    backup_count: int = 5,
) -> Path:
    """Attach rotating file logging for the control plane (failures + key events)."""
    target_dir = log_dir or Path(os.getenv("CONTROL_PLANE_LOG_DIR", DEFAULT_CONTROL_LOG_DIR))
    target_dir.mkdir(parents=True, exist_ok=True)
    log_path = (target_dir / log_name).resolve()

    formatter = _log_formatter()
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    if not any(isinstance(handler, logging.StreamHandler) for handler in root.handlers):
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)

    if not _has_file_handler(root, log_path):
        file_handler = RotatingFileHandler(
            log_path,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    quiet_uvicorn_poll_access_logs()

    logging.getLogger("backtrading").info("[CONTROL] File logging enabled path=%s", log_path)
    return log_path


def live_engine_log_path(engine_id: str, log_dir: Path | None = None) -> Path:
    target_dir = log_dir or Path(os.getenv("LIVE_ENGINE_LOG_DIR", DEFAULT_LIVE_LOG_DIR))
    target_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in engine_id.lower())
    safe = safe.strip("-") or "execution"
    return (target_dir / f"{safe}.log").resolve()
