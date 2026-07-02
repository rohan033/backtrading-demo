"""Agent Mode thread metadata: focus instrument + UI phase cascade."""

from __future__ import annotations

from typing import Any

from control_plane.execution_source_links import symbol_from_action

AGENT_PRODUCT = "agent_mode"
UI_PHASE_CHAT = "chat"
UI_PHASE_TRADING = "trading"


def _is_agent_thread(session: dict[str, Any]) -> bool:
    metadata = session.get("metadata") or {}
    return metadata.get("product") == AGENT_PRODUCT


def _normalize_symbol(symbol: str | None) -> str:
    text = str(symbol or "").strip().upper()
    if not text:
        return ""
    return text.split("-")[0].split(".")[0]


def _latest_strategy_action(session: dict[str, Any]) -> dict[str, Any] | None:
    """Pick the best strategy action — prefer running/linked, then most recently updated."""
    actions = session.get("actions") or []
    candidates: list[dict[str, Any]] = []
    for action in actions:
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("type") or "")
        payload = action.get("payload") or {}
        if "strategy" in action_type or payload.get("symbol"):
            candidates.append(action)
    if not candidates:
        return None

    metadata = session.get("metadata") or {}
    preferred_sym = _normalize_symbol(str((metadata.get("focus") or {}).get("symbol") or ""))

    def _score(action: dict[str, Any]) -> tuple[int, int, int, str]:
        status = str(action.get("status") or "").lower()
        status_rank = {
            "running": 0,
            "active": 0,
            "starting": 1,
            "saved": 2,
            "open": 3,
        }.get(status, 4)
        payload = action.get("payload") or {}
        has_exec = 0 if payload.get("execution_id") else 1
        action_sym = _normalize_symbol(str(payload.get("symbol") or ""))
        sym_match = 1 if preferred_sym and action_sym == preferred_sym else 0
        updated = str(action.get("updated_at") or action.get("created_at") or "")
        return (status_rank, has_exec, sym_match, updated)

    candidates.sort(key=_score)
    return candidates[0]


def focus_from_action(action: dict[str, Any]) -> dict[str, Any] | None:
    payload = action.get("payload") or {}
    symbol = str(payload.get("symbol") or "").strip()
    if not symbol and action.get("title"):
        symbol = symbol_from_action(action) or ""
    if not symbol:
        return None
    return {
        "symbol": symbol,
        "token": str(payload.get("token") or "").strip() or None,
        "exchange": str(payload.get("exchange") or "NSE").strip(),
        "broker": str(payload.get("broker") or "angel").strip(),
        "account_env": str(payload.get("account_env") or "live").strip(),
        "close_price": payload.get("close_price"),
        "long_percent": payload.get("long_percent"),
        "short_percent": payload.get("short_percent"),
        "initial_threshold": payload.get("initial_threshold"),
        "max_available_capital": payload.get("max_available_capital"),
        "execution_id": str(payload.get("execution_id") or "").strip() or None,
    }


def _engine_priority(engine: dict[str, Any]) -> tuple[int, str]:
    status = str(engine.get("status") or "").lower()
    rank = {"running": 4, "starting": 3, "scheduled": 2, "stopped": 1}.get(status, 0)
    updated = str(engine.get("updated_at") or engine.get("id") or "")
    return (rank, updated)


def _focus_from_engine(engine: dict[str, Any], focus: dict[str, Any]) -> dict[str, Any]:
    """Overlay engine fields onto focus — engine wins for instrument identity."""
    metadata = engine.get("metadata") or {}
    config = metadata.get("execution_config") or {}
    executor = metadata.get("executor_payload") or {}

    symbol = str(engine.get("symbol") or config.get("symbol") or "").strip()
    if symbol:
        focus["symbol"] = symbol

    token = engine.get("token") or config.get("token")
    if token:
        focus["token"] = str(token)

    broker = str(engine.get("broker") or config.get("broker") or "").strip()
    if broker:
        focus["broker"] = broker

    account_env = str(config.get("account_env") or metadata.get("account_env") or "").strip()
    if account_env:
        focus["account_env"] = account_env

    exchange = str(config.get("exchange") or executor.get("exchange") or "").strip()
    if exchange:
        focus["exchange"] = exchange

    engine_id = str(engine.get("id") or "")
    if engine_id:
        focus["execution_id"] = engine_id

    for key in ("close_price", "long_percent", "short_percent", "initial_threshold", "max_available_capital"):
        value = executor.get(key)
        if value is None:
            value = config.get(key)
        if value is not None:
            focus[key] = value

    return focus


def _linked_session_engines(session_id: str, registry: Any) -> list[dict[str, Any]]:
    engines = registry.list_engines() if hasattr(registry, "list_engines") else []
    linked: list[dict[str, Any]] = []
    for engine in engines:
        meta = engine.get("metadata") or {}
        config = meta.get("execution_config") or {}
        meta_id = str(meta.get("source_meta_id") or config.get("source_meta_id") or "")
        if meta_id != session_id:
            continue
        source_id = str(meta.get("source_id") or "")
        if source_id and source_id not in {"ai_research", "agent_mode"}:
            continue
        linked.append(engine)
    linked.sort(key=_engine_priority, reverse=True)
    return linked


def resolve_agent_focus(session: dict[str, Any], registry: Any | None = None) -> dict[str, Any]:
    """Canonical trade focus — running execution beats open suggestions on other symbols."""
    if not _is_agent_thread(session):
        return {}

    if registry is None:
        from control_plane.engine_registry import EngineRegistry

        registry = EngineRegistry()

    metadata = dict(session.get("metadata") or {})
    focus = dict(metadata.get("focus") or {})
    session_id = str(session.get("session_id") or "")
    linked = _linked_session_engines(session_id, registry) if session_id else []

    active_statuses = {"running", "active", "starting"}
    for engine in linked:
        if str(engine.get("status") or "").lower() in active_statuses:
            return _focus_from_engine(engine, dict(focus))

    exec_id = str(focus.get("execution_id") or "").strip()
    if exec_id:
        for engine in linked:
            if str(engine.get("id") or "") == exec_id:
                return _focus_from_engine(engine, dict(focus))
        for action in session.get("actions") or []:
            if not isinstance(action, dict):
                continue
            payload = action.get("payload") or {}
            if str(payload.get("execution_id") or "") == exec_id:
                from_action = focus_from_action(action)
                if from_action:
                    return {**focus, **{k: v for k, v in from_action.items() if v is not None}}

    action = _latest_strategy_action(session)
    if action:
        payload = action.get("payload") or {}
        if str(payload.get("execution_id") or "").strip():
            from_action = focus_from_action(action)
            if from_action:
                return {**focus, **{k: v for k, v in from_action.items() if v is not None}}

    if focus.get("symbol"):
        return focus

    if action:
        from_action = focus_from_action(action)
        if from_action:
            return {**focus, **{k: v for k, v in from_action.items() if v is not None}}

    return focus


def sync_focus_from_registry(session: dict[str, Any], registry: Any) -> dict[str, Any]:
    """Attach latest linked execution fields to focus from engine registry."""
    if not _is_agent_thread(session):
        return session

    session_id = str(session.get("session_id") or "")
    if not session_id:
        return session

    metadata = dict(session.get("metadata") or {})
    focus = dict(metadata.get("focus") or {})

    linked = _linked_session_engines(session_id, registry)
    if not linked:
        return session

    focus = _focus_from_engine(linked[0], focus)

    metadata["focus"] = focus
    if focus.get("symbol"):
        metadata["ui_phase"] = UI_PHASE_TRADING

    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    updated = store.update_session(session_id, {"metadata": metadata})
    if updated:
        return sync_focus_from_actions(updated)
    return {**session, "metadata": metadata}


def sync_focus_from_actions(session: dict[str, Any]) -> dict[str, Any]:
    """Derive metadata.focus and ui_phase from session actions."""
    if not _is_agent_thread(session):
        return session

    metadata = dict(session.get("metadata") or {})
    action = _latest_strategy_action(session)
    if not action:
        return session

    new_focus = focus_from_action(action)
    if not new_focus:
        return session

    prev_focus = metadata.get("focus") or {}
    prev_sym = _normalize_symbol(str(prev_focus.get("symbol") or ""))
    new_sym = _normalize_symbol(str(new_focus.get("symbol") or ""))
    payload = action.get("payload") or {}
    has_exec = bool(str(payload.get("execution_id") or "").strip())
    prev_exec = str(prev_focus.get("execution_id") or "").strip()

    if new_sym and prev_sym and new_sym != prev_sym:
        if not has_exec and prev_exec:
            return session
        metadata["focus"] = {k: v for k, v in new_focus.items() if v is not None}
    else:
        metadata["focus"] = {
            **prev_focus,
            **{k: v for k, v in new_focus.items() if v is not None},
        }

    symbol = metadata["focus"].get("symbol")
    if symbol and metadata.get("ui_phase") != UI_PHASE_TRADING:
        metadata["ui_phase"] = UI_PHASE_TRADING

    session_id = session.get("session_id")
    if not session_id:
        return {**session, "metadata": metadata}

    from api.ai_research_routes import get_ai_research_store

    updated = get_ai_research_store().update_session(session_id, {"metadata": metadata})
    return updated or {**session, "metadata": metadata}


def set_ui_phase(session_id: str, phase: str) -> dict[str, Any] | None:
    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    session = store.get_session(session_id)
    if not session or not _is_agent_thread(session):
        return None
    metadata = dict(session.get("metadata") or {})
    metadata["ui_phase"] = phase if phase in (UI_PHASE_CHAT, UI_PHASE_TRADING) else UI_PHASE_CHAT
    return store.update_session(session_id, {"metadata": metadata})


def update_focus_from_tool(
    session_id: str,
    *,
    tool_name: str | None,
    tool_detail: str | None = None,
    symbol: str | None = None,
    execution_id: str | None = None,
) -> dict[str, Any] | None:
    from api.ai_research_routes import get_ai_research_store

    store = get_ai_research_store()
    session = store.get_session(session_id)
    if not session or not _is_agent_thread(session):
        return None

    metadata = dict(session.get("metadata") or {})
    focus = dict(metadata.get("focus") or {})
    prev_sym = _normalize_symbol(str(focus.get("symbol") or ""))

    if symbol:
        new_sym = _normalize_symbol(symbol)
        if new_sym and prev_sym and new_sym != prev_sym:
            focus = {"symbol": symbol}
        else:
            focus["symbol"] = symbol
    if execution_id:
        focus["execution_id"] = execution_id

    name = str(tool_name or "").lower()
    if name in {"create_strategy", "start_strategy", "search_instruments"} and symbol:
        metadata["ui_phase"] = UI_PHASE_TRADING

    if focus:
        metadata["focus"] = focus

    updated = store.update_session(session_id, {"metadata": metadata})
    if updated:
        from control_plane.engine_registry import EngineRegistry

        synced = sync_focus_from_registry(updated, EngineRegistry())
        return sync_focus_from_actions(synced)
    return None
