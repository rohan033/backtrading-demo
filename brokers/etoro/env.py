import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv


REPO_ROOT = Path(__file__).resolve().parents[2]
ETORO_PUBLIC_API_BASE_URL = "https://public-api.etoro.com/api/v1"
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
    load_dotenv(REPO_ROOT / f".{env_name}.env", override=False)
    return env_name


def etoro_env_values(account_env: str | None = None) -> tuple[str, dict[str, str]]:
    """Return selected eToro env file values merged with process env overrides."""
    env_name = etoro_env_name(account_env)
    file_values = {
        key: value
        for key, value in dotenv_values(REPO_ROOT / f".{env_name}.env").items()
        if value is not None
    }
    return env_name, {**file_values, **os.environ}


def etoro_env_name(account_env: str | None = None) -> str:
    selected = (account_env or os.getenv("BROKER_ENV") or os.getenv("ETORO_ENV") or "demo").lower()
    env_name = "demo" if selected == "demo" else "live"
    return env_name


def normalize_etoro_api_env(value: str | None) -> str:
    selected = (value or "demo").lower()
    return "demo" if selected == "demo" else "real"
