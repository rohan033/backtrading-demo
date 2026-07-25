import copy
import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTROL_LOG_DIR = REPO_ROOT / "logs" / "control-plane"
DEFAULT_LIVE_LOG_DIR = REPO_ROOT / "logs" / "executions"
UVICORN_LOG_CONFIG_PATH = REPO_ROOT / "logs" / "uvicorn_log_config.json"

# High-frequency control-plane traffic — noisy at INFO in uvicorn access logs.
_QUIET_ACCESS_RE = re.compile(
    r'"(?:GET /api/control/|POST /api/control/engines/[^"]+/heartbeat|'
    r'GET /api/watchlist/|GET /api/control/search|'
    r'(?:GET|POST) /api/screeners|GET /api/trade-halts/|GET /api/agentic/)',
    re.IGNORECASE,
)

# High-frequency app logs on the control plane (keep failures at WARNING+).
_QUIET_APP_RE = re.compile(
    r'\[(?:WATCHLIST_CANDLES|CONTROL_SEARCH|INSTRUMENT)\]',
    re.IGNORECASE,
)


def _poll_logs_enabled() -> bool:
    return os.getenv("CONTROL_PLANE_LOG_POLL_GETS", "").strip().lower() in {"1", "true", "yes", "on"}


class UvicornAccessPollFilter(logging.Filter):
    """Drop uvicorn access lines for poll GETs and engine heartbeat POSTs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if _poll_logs_enabled():
            return True
        return _QUIET_ACCESS_RE.search(record.getMessage()) is None


class HighFrequencyAppLogFilter(logging.Filter):
    """Drop repetitive INFO lines from poll-heavy control-plane handlers."""

    def filter(self, record: logging.LogRecord) -> bool:
        if _poll_logs_enabled():
            return True
        if record.levelno > logging.INFO:
            return True
        return _QUIET_APP_RE.search(record.getMessage()) is None


def build_uvicorn_log_config() -> dict[str, object]:
    """Uvicorn default logging config with poll-access filter on the access handler."""
    from uvicorn.config import LOGGING_CONFIG

    config = copy.deepcopy(LOGGING_CONFIG)
    config.setdefault("filters", {})["quiet_poll_access"] = {
        "()": "control_plane.ops_logging.UvicornAccessPollFilter",
    }
    access_handler = config.get("handlers", {}).get("access")
    if isinstance(access_handler, dict):
        access_handler["filters"] = ["quiet_poll_access"]
    return config


def write_uvicorn_log_config(path: Path | None = None) -> Path:
    target = (path or UVICORN_LOG_CONFIG_PATH).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    import json

    target.write_text(json.dumps(build_uvicorn_log_config(), indent=2), encoding="utf-8")
    return target


def quiet_uvicorn_poll_access_logs() -> None:
    if _poll_logs_enabled():
        return
    filt = UvicornAccessPollFilter()
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, UvicornAccessPollFilter) for item in access_logger.filters):
        access_logger.addFilter(filt)
    for handler in access_logger.handlers:
        if not any(isinstance(item, UvicornAccessPollFilter) for item in handler.filters):
            handler.addFilter(filt)


def quiet_high_frequency_app_logs() -> None:
    if _poll_logs_enabled():
        return
    filt = HighFrequencyAppLogFilter()
    root = logging.getLogger()
    if not any(isinstance(item, HighFrequencyAppLogFilter) for item in root.filters):
        root.addFilter(filt)
    for handler in root.handlers:
        if not any(isinstance(item, HighFrequencyAppLogFilter) for item in handler.filters):
            handler.addFilter(filt)
    backtrading = logging.getLogger("backtrading")
    if not any(isinstance(item, HighFrequencyAppLogFilter) for item in backtrading.filters):
        backtrading.addFilter(filt)


def quiet_http_client_logs() -> None:
    """Drop httpx/httpcore per-request INFO lines (e.g. Telegram long-poll)."""
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


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
    quiet_high_frequency_app_logs()
    quiet_http_client_logs()

    logging.getLogger("backtrading").info("[CONTROL] File logging enabled path=%s", log_path)
    return log_path


def live_engine_log_path(engine_id: str, log_dir: Path | None = None) -> Path:
    target_dir = log_dir or Path(os.getenv("LIVE_ENGINE_LOG_DIR", DEFAULT_LIVE_LOG_DIR))
    target_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in engine_id.lower())
    safe = safe.strip("-") or "execution"
    return (target_dir / f"{safe}.log").resolve()
