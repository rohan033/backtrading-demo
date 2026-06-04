"""Control plane FastAPI app (stable entry: api.server:app re-exports this)."""

from api.server import app

__all__ = ["app"]
