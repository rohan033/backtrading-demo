from SmartApi import SmartConnect #or from SmartApi.smartConnect import SmartConnect
import pyotp
from logzero import logger
import os


def _angel_env(primary: str, *fallbacks: str) -> str | None:
    for key in (primary, *fallbacks):
        value = os.getenv(key)
        if value:
            return value
    return None


def angel_bearer_token(token: str | None) -> str | None:
    if not token:
        return None
    normalized = token.strip()
    if normalized.lower().startswith("bearer "):
        return normalized
    return f"Bearer {normalized}"


class AngelClient():
    def __init__(self):
        self.name = "Angel"
        self.api_key = _angel_env("ANGEL_API_KEY", "API_KEY")
        self.userid = _angel_env("ANGEL_USER_ID", "CLIENT_ID")
        self.mpin = _angel_env("ANGEL_MPIN", "MPIN")
        self.totp_key = _angel_env("ANGEL_TOTP_KEY", "TOTP_KEY")
        self._client = SmartConnect(self.api_key)
        self._auth_token: str | None = None
        self._feed_token: str | None = None

    def ensure_session_tokens(self) -> bool:
        if self._auth_token and self._feed_token:
            return True
        access_token = getattr(self._client, "access_token", None)
        feed_token = getattr(self._client, "feed_token", None)
        if access_token and feed_token:
            self._auth_token = access_token
            self._feed_token = feed_token
            return True
        return False

    def generate_session(self):
        try:
            totp = pyotp.TOTP(self.totp_key).now()
        except Exception as e:
            logger.error("Invalid Token: The provided token is not valid.")
            raise e

        session = self._client.generateSession(self.userid, self.mpin, totp)

        if not session or session.get("status") is not True:
            logger.error(session)
            raise Exception("Session generation failed")

        refresh_token = getattr(self._client, "refresh_token", None)
        if refresh_token:
            try:
                self._client.generateToken(refresh_token)
            except Exception as exc:
                logger.warning(
                    "[Angel] generateToken after login failed (continuing with session tokens): %s",
                    exc,
                )

        self._auth_token = self._client.access_token
        self._feed_token = self._client.feed_token
        if not self._auth_token or not self._feed_token:
            raise Exception("Session generation did not return websocket tokens")
        logger.info("Session generated successfully")
        return session
   



    