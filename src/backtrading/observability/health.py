"""Health payload helpers (see docs/observability.md)."""

from __future__ import annotations

from typing import Any


def control_plane_health_payload() -> dict[str, Any]:
    return {"status": "ok", "component": "control_plane"}


def live_engine_health_payload(
    *,
    engine_id: str | None,
    broker: str | None,
    degraded: bool = False,
    uptime_s: float | None = None,
) -> dict[str, Any]:
    status = "degraded" if degraded else "ok"
    payload: dict[str, Any] = {
        "status": status,
        "component": "live_engine",
        "engine_id": engine_id,
        "broker": broker,
    }
    if uptime_s is not None:
        payload["uptime_s"] = uptime_s
    return payload
