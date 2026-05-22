import os
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from logzero import logger

from brokers.etoro.env import ETORO_ENV_PATHS, ETORO_PUBLIC_API_BASE_URL, etoro_env_values, normalize_etoro_api_env


class EtoroApiError(Exception):
    def __init__(self, message: str, status_code: int | None = None, payload: Any = None):
        super().__init__(message)
        self.name = "EtoroApiError"
        self.status_code = status_code
        self.payload = payload


class EtoroRateLimitError(EtoroApiError):
    def __init__(self, message: str = "eToro rate limit exceeded", payload: Any = None):
        super().__init__(message, 429, payload)
        self.name = "EtoroRateLimitError"


class EtoroClient:
    def __init__(self, account_env: str | None = None):
        loaded_env, config = etoro_env_values(account_env)
        self.name = "eToro"
        self.api_key = config.get("ETORO_API_KEY")
        self.user_key = config.get("ETORO_USER_KEY") or config.get("ETORO_ACCOUNT_ID")
        self.access_token = config.get("ETORO_ACCESS_TOKEN")
        self.account_env = loaded_env
        self.env = normalize_etoro_api_env(loaded_env if account_env else config.get("ETORO_ENV", loaded_env))
        self.base_url = ETORO_PUBLIC_API_BASE_URL
        self._paths = ETORO_ENV_PATHS[self.account_env]
        self.timeout = float(config.get("ETORO_TIMEOUT_SECONDS", "20"))
        self.leverage = int(config.get("ETORO_LEVERAGE", "1"))
        self._session = {"env": self.env, "account_env": self.account_env}

    def generate_session(self):
        """Validate local eToro credentials.

        eToro Public API calls use either a bearer token or an API-key/user-key
        pair. Token exchange is intentionally not mixed into this Public API
        client because SSO uses a different host and form-encoded requests.
        """
        if self.access_token and (self.api_key or self.user_key):
            raise ValueError("Configure either ETORO_ACCESS_TOKEN or ETORO_API_KEY/ETORO_USER_KEY, not both")

        if not self.access_token and not (self.api_key and self.user_key):
            raise ValueError("Missing eToro credentials: set ETORO_ACCESS_TOKEN or ETORO_API_KEY and ETORO_USER_KEY")

        if self.env not in {"demo", "real"}:
            raise ValueError("ETORO_ENV must be 'demo', 'live', or 'real'")

        logger.info("[eToro] Session configured for %s environment", self.env)
        return self._session

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "x-request-id": str(uuid.uuid4()),
        }
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        else:
            headers["x-api-key"] = self.api_key
            headers["x-user-key"] = self.user_key
        return headers

    @staticmethod
    def _query_string(params: dict[str, Any] | None) -> str:
        if not params:
            return ""

        parts = []
        for key, value in params.items():
            if value is None:
                continue
            encoded_key = urllib.parse.quote(str(key), safe="")
            if isinstance(value, (list, tuple, set)):
                # eToro requires literal commas for list-valued query params.
                encoded_value = ",".join(urllib.parse.quote(str(item), safe="") for item in value)
            else:
                encoded_value = urllib.parse.quote(str(value), safe="")
            parts.append(f"{encoded_key}={encoded_value}")
        return f"?{'&'.join(parts)}" if parts else ""

    def _request_sync(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | list[Any] | None = None,
        trade_execution: bool = False,
    ) -> Any:
        self.generate_session()
        url = f"{self.base_url.rstrip('/')}{path}{self._query_string(params)}"
        body = None if json_body is None else json.dumps(json_body).encode("utf-8")

        attempts = 3 if method.upper() == "GET" else 1
        if trade_execution:
            attempts = 1

        last_error: Exception | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(url, data=body, headers=self._headers(), method=method.upper())
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                payload = self._read_error_payload(exc)
                error = self._api_error(exc.code, payload)

                if exc.code == 429 and attempt < attempts - 1:
                    time.sleep([1, 5, 30][min(attempt, 2)])
                    continue
                if exc.code >= 500 and not trade_execution and attempt < attempts - 1:
                    time.sleep([0.2, 0.6, 1.5][min(attempt, 2)])
                    continue
                raise error from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last_error = exc
                if trade_execution or attempt == attempts - 1:
                    raise EtoroApiError(f"eToro request failed: {exc}") from exc
                time.sleep([0.2, 0.6, 1.5][min(attempt, 2)])

        raise EtoroApiError(f"eToro request failed: {last_error}")

    @staticmethod
    def _read_error_payload(exc: urllib.error.HTTPError) -> Any:
        try:
            raw = exc.read().decode("utf-8")
            return json.loads(raw) if raw else {}
        except Exception:
            return {}

    @staticmethod
    def _api_error(status_code: int, payload: Any) -> EtoroApiError:
        if isinstance(payload, dict):
            message = payload.get("error_description") or payload.get("error") or payload.get("message")
        else:
            message = None
        message = message or f"eToro API returned HTTP {status_code}"

        if status_code == 429:
            return EtoroRateLimitError(message, payload)
        return EtoroApiError(message, status_code, payload)

    async def arequest(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | list[Any] | None = None,
        trade_execution: bool = False,
    ) -> Any:
        import asyncio

        return await asyncio.to_thread(
            self._request_sync,
            method,
            path,
            params=params,
            json_body=json_body,
            trade_execution=trade_execution,
        )

    async def aget_rates(self, instrument_ids: list[int]) -> list[dict[str, Any]]:
        if not instrument_ids:
            return []

        response = await self.arequest(
            "GET",
            "/market-data/instruments/rates",
            params={"instrumentIds": instrument_ids[:100]},
        )
        return response.get("rates", []) if isinstance(response, dict) else []

    async def aresolve_instrument_id(self, symbol: str) -> int | None:
        if not symbol:
            return None

        instruments = await self.asearch_instruments(symbol)

        symbol_upper = symbol.upper()
        for instrument in instruments:
            if not isinstance(instrument, dict):
                continue
            candidate_symbol = str(
                instrument.get("symbolFull")
                or instrument.get("internalSymbolFull")
                or instrument.get("symbol")
                or ""
            ).upper()
            if candidate_symbol == symbol_upper or not candidate_symbol:
                instrument_id = instrument.get("instrumentId") or instrument.get("instrumentID") or instrument.get("InstrumentID")
                return int(instrument_id) if instrument_id is not None else None
        return None

    async def asearch_instruments(self, symbol: str) -> list[dict[str, Any]]:
        if not symbol:
            return []

        response = await self.arequest(
            "GET",
            "/market-data/search",
            params={"internalSymbolFull": symbol},
        )
        instruments = []
        if isinstance(response, dict):
            instruments = (
                response.get("items")
                or response.get("instruments")
                or response.get("Instrument")
                or response.get("data")
                or []
            )
        if isinstance(instruments, dict):
            instruments = [instruments]
        return [instrument for instrument in instruments if isinstance(instrument, dict)]

    def execution_base_path(self) -> str:
        return self._paths["execution"]

    def info_base_path(self) -> str:
        return self._paths["info"]
