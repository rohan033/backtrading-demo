"""Broker plugin registry."""

from __future__ import annotations

from typing import Any, Callable

_factories: dict[str, Callable[..., Any]] = {}


def register(name: str, factory: Callable[..., Any]) -> None:
    _factories[name.lower()] = factory


def get(name: str) -> Callable[..., Any] | None:
    return _factories.get((name or "").lower())


def register_defaults() -> None:
    if _factories:
        return
    register("fake", lambda **kw: __import__(
        "tests.fake_test_client", fromlist=["FakeTradingClient"]
    ).FakeTradingClient(**kw))
