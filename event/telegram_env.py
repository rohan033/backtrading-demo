"""Load Telegram credentials from .telegram.env at repo root."""

import logging
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
TELEGRAM_ENV_FILE = REPO_ROOT / ".telegram.env"


def load_telegram_env(*, override: bool = False) -> bool:
    """Load .telegram.env if present. Returns True when the file was loaded."""
    if not TELEGRAM_ENV_FILE.is_file():
        return False
    load_dotenv(TELEGRAM_ENV_FILE, override=override)
    logging.getLogger("backtrading").info("[TELEGRAM] Loaded env from %s", TELEGRAM_ENV_FILE)
    return True
