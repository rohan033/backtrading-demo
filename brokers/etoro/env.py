import logging
import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

log = logging.getLogger("backtrading.etoro.env")


REPO_ROOT = Path(__file__).resolve().parents[2]
ETORO_PUBLIC_API_BASE_URL = "https://public-api.etoro.com/api/v1"
ETORO_HTTP_USER_AGENT = "python-requests/2.33.1"
ETORO_ENV_PATHS = {
    "demo": {
        "info": "/trading/info/demo",
        "execution": "/trading/execution/demo",
    },
    "live": {
        "info": "/trading/info/real",
        "execution": "/trading/execution",
    },
}


def load_etoro_env(account_env: str | None = None) -> str:
    """Load eToro credentials for the selected account environment."""
    env_name = etoro_env_name(account_env)
    load_dotenv(etoro_env_file_path(account_env), override=False)
    return env_name


def etoro_env_values(account_env: str | None = None) -> tuple[str, dict[str, str]]:
    """Return process env merged with the selected eToro env file values.

    The app loads a generic .env at startup, so selected account files must win
    for ETORO_* credentials; otherwise a demo execution can accidentally reuse
    live/default keys from the parent process.
    """
    env_name = etoro_env_name(account_env)
    env_file = etoro_env_file_path(account_env)
    file_values = {
        key: value
        for key, value in dotenv_values(env_file).items()
        if value is not None
    }
    merged = {**os.environ, **file_values}
    _log_etoro_credentials(
        requested_profile=account_env,
        env_name=env_name,
        env_file=env_file,
        file_values=file_values,
        merged=merged,
    )
    return env_name, merged


def etoro_env_name(account_env: str | None = None) -> str:
    selected = (account_env or os.getenv("BROKER_ENV") or os.getenv("ETORO_ENV") or "demo").lower()
    env_name = "demo" if selected == "demo" else "live"
    return env_name


def etoro_env_file_path(account_env: str | None = None) -> Path:
    selected = (account_env or os.getenv("BROKER_ENV") or os.getenv("ETORO_ENV") or "demo").lower()
    if selected in {"live.read", "live-read", "live_read"}:
        return REPO_ROOT / "live.read.env"
    return REPO_ROOT / f".{etoro_env_name(account_env)}.env"


def normalize_etoro_api_env(value: str | None) -> str:
    selected = (value or "demo").lower()
    return "demo" if selected == "demo" else "real"


def _log_etoro_credentials(
    *,
    requested_profile: str | None,
    env_name: str,
    env_file: Path,
    file_values: dict[str, str],
    merged: dict[str, str],
) -> None:
    credential_keys = (
        "ETORO_API_KEY",
        "ETORO_USER_KEY",
        "ETORO_ACCOUNT_ID",
        "ETORO_ACCESS_TOKEN",
    )
    log.info(
        "[eToro env] loading profile=%r resolved_env=%s file=%s exists=%s",
        requested_profile,
        env_name,
        env_file,
        env_file.exists(),
    )
    for key in credential_keys:
        file_value = file_values.get(key)
        merged_value = merged.get(key)
        source = "file" if file_value is not None else ("process" if merged_value is not None else "missing")
        log.info(
            "[eToro env] %s source=%s file=%r merged=%r",
            key,
            source,
            file_value,
            merged_value,
        )
