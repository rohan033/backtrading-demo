"""Strategy registry (shim to repo-root strategies/)."""

from strategies.factory import create_strategy
from strategies.base import BaseStrategy

__all__ = ["create_strategy", "BaseStrategy"]
