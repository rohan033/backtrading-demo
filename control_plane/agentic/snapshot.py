"""Atomic, backward-compatible session snapshot projection.

The snapshot is the single source of truth the dashboard renders from. It
carries everything the wireframe needs: overview stats, positions, the unified
log (events with data + oneline + confidence), live thinking buffers, the list
of spawned sub-agents, the deterministic market-monitor states, and the scanner
suggestions. No A2UI / A2UI surfaces anywhere.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable

from control_plane.agentic.config import DEFAULT_CONFIG


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


SERVICE_NAMES = (
    "market_hunter",
    "position_monitor",
    "news_monitor",
    "risk_monitor",
    "broker_reconciler",
    "strategy_scheduler",
    "main_orchestrator",
)

# The five Market Monitor mini-cards in the wireframe.
MONITOR_CARDS: tuple[tuple[str, str], ...] = (
    ("halt_monitor", "Halt monitor"),
    ("news_monitor", "News monitor"),
    ("rotation_monitor", "Rotation monitor"),
    ("risk_monitor", "Risk monitor"),
    ("portfolio_monitor", "Portfolio monitor"),
)

MAX_SUBAGENTS = 16
MAX_THINKING = 8


def _trim_thinking_blocks(blocks: list[dict[str, Any]]) -> None:
    """Drop oldest completed blocks first; never trim in-flight streams."""
    if len(blocks) <= MAX_THINKING:
        return
    completed = [index for index, block in enumerate(blocks) if block.get("done")]
    while len(blocks) > MAX_THINKING and completed:
        drop = completed.pop(0)
        blocks.pop(drop)
        completed = [index for index, block in enumerate(blocks) if block.get("done")]


def _default_monitors() -> dict[str, Any]:
    return {
        name: {
            "name": name,
            "label": label,
            "status": "idle",
            "oneline": "Waiting",
            "data": {},
            "should_spawn_sub_agent": False,
            "updated_at": None,
        }
        for name, label in MONITOR_CARDS
    }


def default_snapshot(session: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    return {
        "version": 2,
        "session_id": session["id"],
        "updated_at": now,
        "portfolio": {},
        "positions": [],
        "playbooks": {},
        "exit_plans": {},
        "events": [],
        "alerts": [],
        "recommendations": [],
        "performance": [],
        "services": {
            name: {
                "name": name,
                "status": "idle",
                "last_run_at": None,
                "current_work": "Waiting",
                "kind": "llm" if name == "main_orchestrator" else "deterministic",
            }
            for name in SERVICE_NAMES
        },
        "monitors": _default_monitors(),
        "subagents": [],
        "thinking": [],
        "tasks": [],
        "agent_state": {
            "orchestrator": "idle",
            "last_wakeup_at": None,
            "wakeups_last_hour": 0,
        },
        "extensions": {
            "regime_strategy": None,
            "approval_gate": None,
            "multi_session_group": None,
        },
    }


def _is_a2ui_event(event: dict[str, Any]) -> bool:
    """Legacy guard — the agentic path no longer emits A2UI, but old rows may exist."""
    if event.get("text") == "agent_a2ui_surface":
        return True
    meta = event.get("meta") or {}
    return meta.get("type") == "a2ui_surface"


class SessionSnapshot:
    def __init__(self, store: Any, session_id: str) -> None:
        self.store = store
        self.session_id = session_id

    def mutate(self, callback: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        session = self.store.get_session(self.session_id)
        if session is None:
            raise KeyError(self.session_id)

        def apply(current: dict[str, Any]) -> dict[str, Any]:
            snapshot = current or default_snapshot(session)
            callback(snapshot)
            snapshot["updated_at"] = _now()
            return snapshot

        return self.store.mutate_snapshot(self.session_id, apply)

    # ── Deterministic monitor states ──

    def record_monitor(
        self,
        card: str,
        *,
        status: str,
        oneline: str,
        data: dict[str, Any] | None = None,
        should_spawn_sub_agent: bool = False,
    ) -> None:
        label = dict(MONITOR_CARDS).get(card, card.replace("_", " ").title())

        def update(state: dict[str, Any]) -> None:
            monitors = state.setdefault("monitors", {})
            monitors[card] = {
                "name": card,
                "label": label,
                "status": status,
                "oneline": oneline,
                "data": dict(data or {}),
                "should_spawn_sub_agent": bool(should_spawn_sub_agent),
                "updated_at": _now(),
            }

        self.mutate(update)

    # ── Spawned sub-agents (Agents Status panel) ──

    def record_subagent(
        self,
        *,
        sub_id: str,
        name: str,
        tier: str | None,
        ticker: str | None,
        oneline: str,
        run_id: str | None = None,
    ) -> None:
        def update(state: dict[str, Any]) -> None:
            subs: list[dict[str, Any]] = state.setdefault("subagents", [])
            subs.append(
                {
                    "id": sub_id,
                    "name": name,
                    "tier": tier,
                    "ticker": ticker,
                    "status": "active",
                    "oneline": oneline,
                    "data": "",
                    "confidence": None,
                    "run_id": run_id,
                    "started_at": _now(),
                    "finished_at": None,
                }
            )
            del subs[:-MAX_SUBAGENTS]

        self.mutate(update)

    def finish_subagent(
        self,
        sub_id: str,
        *,
        oneline: str,
        data: str,
        confidence: float,
        status: str = "done",
    ) -> None:
        def update(state: dict[str, Any]) -> None:
            for sub in state.setdefault("subagents", []):
                if sub.get("id") == sub_id:
                    sub.update(
                        {
                            "status": status,
                            "oneline": oneline or sub.get("oneline") or "",
                            "data": data,
                            "confidence": confidence,
                            "finished_at": _now(),
                        }
                    )
                    break

        self.mutate(update)

    # ── Streaming thinking buffers ──

    def append_thinking(
        self,
        run_id: str,
        *,
        agent: str,
        token: str,
        ticker: str | None = None,
    ) -> None:
        def update(state: dict[str, Any]) -> None:
            blocks: list[dict[str, Any]] = state.setdefault("thinking", [])
            block = next((b for b in blocks if b.get("run_id") == run_id), None)
            if block is None:
                block = {
                    "run_id": run_id,
                    "agent": agent,
                    "ticker": ticker,
                    "text": "",
                    "oneline": "Thinking…",
                    "done": False,
                    "started_at": _now(),
                    "updated_at": _now(),
                }
                blocks.append(block)
                _trim_thinking_blocks(blocks)
            block["text"] = (block.get("text") or "") + token
            block["updated_at"] = _now()

        self.mutate(update)

    def finish_thinking(
        self,
        run_id: str,
        *,
        oneline: str = "",
        text: str = "",
    ) -> None:
        def update(state: dict[str, Any]) -> None:
            for block in state.setdefault("thinking", []):
                if block.get("run_id") == run_id:
                    block["done"] = True
                    block["updated_at"] = _now()
                    if text:
                        block["text"] = text
                    if oneline:
                        block["oneline"] = oneline
                    elif text:
                        line = re.sub(r"\s+", " ", text.strip())
                        block["oneline"] = line[:179].rstrip() + ("…" if len(line) > 179 else "")
                    break

        self.mutate(update)

    def record_thinking_summary(
        self,
        run_id: str,
        *,
        agent: str,
        text: str,
        ticker: str | None = None,
    ) -> None:
        """Record a complete (non-streamed) thinking block, e.g. synthetic reasoning."""

        def update(state: dict[str, Any]) -> None:
            blocks: list[dict[str, Any]] = state.setdefault("thinking", [])
            blocks.append(
                {
                    "run_id": run_id,
                    "agent": agent,
                    "ticker": ticker,
                    "text": text,
                    "oneline": text.split("\n")[0][:140] if text else "Reasoned",
                    "done": True,
                    "started_at": _now(),
                    "updated_at": _now(),
                }
            )
            _trim_thinking_blocks(blocks)

        self.mutate(update)

    # ── Hydration ──

    def _project_monitors(
        self,
        snapshot: dict[str, Any],
        *,
        portfolio: dict[str, Any],
        services: dict[str, Any],
        positions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Always-populated 5 monitor cards; persisted tick state overlays defaults."""
        monitors = _default_monitors()
        persisted = snapshot.get("monitors") or {}

        open_positions = [p for p in positions if p.get("state") == "open"]
        halted = self._halted_symbols()
        weakening = [p for p in open_positions if p.get("exit_state") == "weakening"]

        monitors["portfolio_monitor"].update(
            {
                "status": "active" if open_positions else "idle",
                "oneline": (
                    f"Exposure {portfolio.get('exposure_pct', 0):.1f}% of "
                    f"{portfolio.get('max_exposure_pct', 0):.0f}% cap · "
                    f"{portfolio.get('open_positions', 0)} open"
                ),
            }
        )
        risk_service = services.get("risk_monitor") or {}
        monitors["risk_monitor"].update(
            {
                "status": risk_service.get("status") or "active",
                "oneline": risk_service.get("current_work")
                or f"Daily-loss & drawdown circuit breakers armed",
            }
        )
        news_service = services.get("news_monitor") or {}
        monitors["news_monitor"].update(
            {
                "status": news_service.get("status") or "idle",
                "oneline": news_service.get("current_work") or "Monitoring position news",
            }
        )
        monitors["halt_monitor"].update(
            {
                "status": "degraded" if halted else "active",
                "oneline": (
                    f"{len(halted)} symbol(s) halted"
                    if halted
                    else f"No halts · watching {len(open_positions)} position(s)"
                ),
            }
        )
        monitors["rotation_monitor"].update(
            {
                "status": "active" if weakening else "idle",
                "oneline": (
                    f"{len(weakening)} weakening — rotation candidates"
                    if weakening
                    else "No rotation pending"
                ),
            }
        )

        for card, value in persisted.items():
            if card in monitors and isinstance(value, dict):
                merged = monitors[card]
                for key in ("status", "oneline", "data", "should_spawn_sub_agent", "updated_at"):
                    if value.get(key) not in (None, "", {}):
                        merged[key] = value[key]
        return monitors

    def _halted_symbols(self) -> set[str]:
        try:
            from control_plane.trade_halts_store import get_trade_halts_store

            rows = get_trade_halts_store().list_all_halts()
        except Exception:
            return set()
        return {
            str(row.get("symbol") or "").upper()
            for row in rows
            if str(row.get("status") or "").lower() == "halted"
        }

    def hydrate(self) -> dict[str, Any]:
        session = self.store.get_session(self.session_id)
        if session is None:
            raise KeyError(self.session_id)
        positions = self.store.list_positions(self.session_id)
        stats = self.store.session_stats(self.session_id)
        events = [
            event
            for event in self.store.list_events(self.session_id, limit=200)
            if not _is_a2ui_event(event)
        ]
        start = float(session.get("start_balance") or 0)
        total_pnl = float(stats["realized_pnl"]) + float(stats["unrealized_pnl"])
        exposure_pct = (float(stats["invested"]) / start * 100) if start > 0 else 0.0

        def update(snapshot: dict[str, Any]) -> None:
            baseline = default_snapshot(session)
            for key, value in baseline.items():
                snapshot.setdefault(key, value)
            for name, value in baseline["services"].items():
                snapshot.setdefault("services", {}).setdefault(name, value)
            snapshot["version"] = 2
            snapshot["portfolio"] = {
                "start_balance": start,
                "equity": start + total_pnl,
                "total_pnl": total_pnl,
                "daily_pnl": float(stats["realized_pnl"]),
                "invested": float(stats["invested"]),
                "exposure_pct": round(exposure_pct, 2),
                "win_rate": stats["win_rate"],
                "open_positions": stats["open_positions"],
                "trades_taken": int(stats["trades_placed"]),
                "max_exposure_pct": float(
                    (session.get("config") or {}).get(
                        "max_exposure_pct", DEFAULT_CONFIG["max_exposure_pct"]
                    )
                ),
            }
            snapshot["positions"] = positions
            exit_plans = snapshot.get("exit_plans") or {}
            if isinstance(exit_plans, dict):
                enriched: list[dict[str, Any]] = []
                for row in positions:
                    payload = dict(row)
                    plan = exit_plans.get(row["id"])
                    if isinstance(plan, dict):
                        payload["exit_plan"] = plan
                    enriched.append(payload)
                snapshot["positions"] = enriched
            snapshot["events"] = events[-100:]
            snapshot["monitors"] = self._project_monitors(
                snapshot,
                portfolio=snapshot["portfolio"],
                services=snapshot.get("services") or {},
                positions=positions,
            )
            snapshot.setdefault("subagents", [])
            snapshot["subagents"] = list(snapshot["subagents"])[-MAX_SUBAGENTS:]
            snapshot.setdefault("thinking", [])
            _trim_thinking_blocks(snapshot["thinking"])
            points = snapshot.setdefault("performance", [])
            point = {"ts": _now(), "equity": round(start + total_pnl, 4)}
            if not points or points[-1].get("equity") != point["equity"]:
                points.append(point)
                del points[:-120]

        return self.mutate(update)
