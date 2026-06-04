"""Strategy lifecycle events emitted from the control plane."""

from typing import Any

from event.telegram_format import enrich_strategy_details

STRATEGY_CREATED = "STRATEGY_CREATED"
STRATEGY_SCHEDULED = "STRATEGY_SCHEDULED"
STRATEGY_DEPLOYED = "STRATEGY_DEPLOYED"
STRATEGY_RUNNING = "STRATEGY_RUNNING"
STRATEGY_STOPPED = "STRATEGY_STOPPED"
STRATEGY_CANCELLED = "STRATEGY_CANCELLED"
STRATEGY_UNSCHEDULED = "STRATEGY_UNSCHEDULED"

STRATEGY_LIFECYCLE_ACTIONS = frozenset({
    STRATEGY_CREATED,
    STRATEGY_SCHEDULED,
    STRATEGY_DEPLOYED,
    STRATEGY_RUNNING,
    STRATEGY_STOPPED,
    STRATEGY_CANCELLED,
    STRATEGY_UNSCHEDULED,
})


def strategy_details_from_engine(
    engine: dict[str, Any],
    *,
    previous_state: str | None = None,
    trigger: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    metadata = engine.get("metadata") or {}
    executor = metadata.get("executor_payload") or {}
    config = metadata.get("execution_config") or {}

    details: dict[str, Any] = {
        "execution_id": engine.get("id"),
        "state": str(engine.get("status") or "").lower() or None,
        "symbol": engine.get("symbol") or executor.get("symbol") or config.get("symbol"),
        "token": engine.get("token") or executor.get("token") or config.get("token"),
        "exchange": metadata.get("exchange") or executor.get("exchange") or config.get("exchange"),
        "broker": engine.get("broker") or config.get("broker"),
        "strategy_name": engine.get("strategy_name") or config.get("strategy_name"),
        "account_env": engine.get("account_env") or config.get("account_env"),
        "scheduled_start_at": metadata.get("scheduled_start_at"),
        "trading_day": metadata.get("trading_day"),
        "schedule_label": metadata.get("schedule_label"),
        "source_id": metadata.get("source_id"),
    }
    if previous_state:
        details["previous_state"] = previous_state
    if trigger:
        details["trigger"] = trigger
    details.update(extra)
    details = enrich_strategy_details(details, executor=executor, config=config)
    return {key: value for key, value in details.items() if value is not None}
