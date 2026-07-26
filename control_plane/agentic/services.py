"""Lightweight deterministic background services for one agentic session."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.agent_contract import MonitorResult
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.events import AgentEvent, EventTier, EventType
from control_plane.agentic.playbooks import review_playbook
from control_plane.agentic.snapshot import SessionSnapshot


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ServiceUnavailable(RuntimeError):
    pass


class PeriodicService:
    name = "service"
    interval_key = ""
    # Which of the 5 Market Monitor wireframe cards this service feeds (if any).
    card: str | None = None

    def __init__(self, session_id: str, store: Any, bus: Any) -> None:
        self.session_id = session_id
        self.store = store
        self.bus = bus
        self.snapshot = SessionSnapshot(store, session_id)

    async def run(self) -> None:
        while True:
            session = self.store.get_session(self.session_id)
            if not session or session.get("status") == "stopped":
                return
            if session.get("status") == "paused" and self.name not in {
                "position_monitor",
                "profit_window_sampler",
                "risk_monitor",
                "broker_reconciler",
                "playbook_reviewer",
            }:
                self._status("paused", "Paused by user")
                self._record_card("idle", "Paused by user")
                await asyncio.sleep(5)
                continue
            self._status("running", "Checking")
            try:
                self.snapshot.hydrate()
                result = await self.tick(session)
                if isinstance(result, MonitorResult):
                    self._status(result.status, result.oneline or "Monitoring")
                    self._record_card(
                        result.status,
                        result.oneline or "Monitoring",
                        data=result.data,
                        should_spawn_sub_agent=result.should_spawn_sub_agent,
                    )
                else:
                    self._status("active", "Monitoring")
                    self._record_card("active", "Monitoring")
            except asyncio.CancelledError:
                raise
            except ServiceUnavailable as exc:
                self._status("unavailable", str(exc)[:120])
                self._record_card("degraded", str(exc)[:120])
            except Exception as exc:
                self._status("degraded", str(exc)[:120])
                self._record_card("degraded", str(exc)[:120])
            interval = float(
                (session.get("config") or {}).get(
                    self.interval_key, DEFAULT_CONFIG[self.interval_key]
                )
            )
            await asyncio.sleep(max(5.0, interval))

    async def tick(self, session: dict[str, Any]) -> MonitorResult | None:
        raise NotImplementedError

    def _record_card(
        self,
        status: str,
        oneline: str,
        *,
        data: dict[str, Any] | None = None,
        should_spawn_sub_agent: bool = False,
    ) -> None:
        if not self.card:
            return
        try:
            self.snapshot.record_monitor(
                self.card,
                status=status,
                oneline=oneline,
                data=data,
                should_spawn_sub_agent=should_spawn_sub_agent,
            )
        except Exception:
            pass

    def _status(self, status: str, work: str) -> None:
        def update(state: dict[str, Any]) -> None:
            service = state.setdefault("services", {}).setdefault(self.name, {})
            service.update(
                {
                    "name": self.name,
                    "kind": "deterministic",
                    "status": status,
                    "current_work": work,
                    "last_run_at": _now(),
                }
            )

        self.snapshot.mutate(update)

    async def publish(
        self,
        type: EventType,
        tier: EventTier,
        payload: dict[str, Any],
        *,
        ticker: str | None = None,
        dedupe_key: str | None = None,
    ) -> None:
        session = self.store.get_session(self.session_id) or {}
        await self.bus.publish(
            AgentEvent(
                session_id=self.session_id,
                type=type,
                tier=tier,
                source=self.name,
                payload=payload,
                ticker=ticker,
                dedupe_key=dedupe_key,
            ),
            dedupe_seconds=float(
                (session.get("config") or {}).get(
                    "event_dedupe_seconds", DEFAULT_CONFIG["event_dedupe_seconds"]
                )
            ),
        )


class PositionMonitor(PeriodicService):
    name = "position_monitor"
    interval_key = "position_monitor_seconds"
    card = "portfolio_monitor"

    async def tick(self, session: dict[str, Any]) -> MonitorResult:
        from control_plane.agentic.config import DEFAULT_CONFIG
        from control_plane.agentic.market_hunter import get_market_hunter
        from control_plane.agentic.portfolio_exit_monitor import manage_portfolio_exits
        from control_plane.agentic.reconciliation import reconcile_session_positions
        from control_plane.agentic.session_store import ACTIVE_POSITION_STATES

        config = session.get("config") or {}
        dry_run = bool(config.get("dry_run", DEFAULT_CONFIG["dry_run"]))
        repaired = 0
        if not dry_run:
            repaired = await reconcile_session_positions(session, self.store)

        stats = self.store.session_stats(self.session_id)
        start = float(session.get("start_balance") or 0.0)
        exposure_cap = start * float(config.get("total_exposure_cap_pct", 80)) / 100.0
        min_alloc = float(config.get("min_allocation_usd", DEFAULT_CONFIG["min_allocation_usd"]))
        headroom = max(0.0, exposure_cap - float(stats["invested"]))
        total_pnl = float(stats["realized_pnl"]) + float(stats["unrealized_pnl"])

        open_positions = self.store.list_positions(self.session_id, states=("open",))
        exit_summary = await manage_portfolio_exits(
            session,
            self.store,
            self.snapshot,
            publish=self.publish,
        )
        profit_actions = int(exit_summary.get("profit_actions") or 0)
        rebuy_candidates = list(exit_summary.get("rebuy_candidates") or [])
        exit_plans = exit_summary.get("exit_plans") or {}
        open_positions = self.store.list_positions(self.session_id, states=("open",))

        active_rows = self.store.list_positions(
            self.session_id, states=ACTIVE_POSITION_STATES
        )
        held = {str(row["ticker"]).upper() for row in active_rows}
        watchlist = {
            str(ticker).upper()
            for ticker in (config.get("tickers") or [])
            if ticker
        }
        open_slots = sorted(ticker for ticker in watchlist if ticker not in held)

        breached = 0
        weakening = 0
        for position in open_positions:
            price = float(position.get("current_price") or position.get("buy_price") or 0)
            stop = float(position.get("stop_loss") or 0)
            if price > 0 and stop > 0 and price <= stop:
                breached += 1
                await self.publish(
                    EventType.STOP_LOSS,
                    EventTier.CRITICAL,
                    {
                        "position_id": position["id"],
                        "price": price,
                        "reason": f"{position['ticker']} hard stop breached at {price:.4f}",
                    },
                    ticker=position["ticker"],
                    dedupe_key=f"stop:{position['id']}",
                )
            elif position.get("exit_state") == "weakening":
                weakening += 1
                await self.publish(
                    EventType.POSITION_WEAKENING,
                    EventTier.FAST,
                    {"position_id": position["id"], "price": price},
                    ticker=position["ticker"],
                    dedupe_key=f"weakening:{position['id']}",
                )

        should_spawn = weakening > 0 or profit_actions > 0 or bool(rebuy_candidates)
        capacity_available = (
            headroom >= min_alloc
            and bool(open_slots)
            and not session.get("stop_reason")
            and session.get("status") == "running"
        )

        if repaired > 0:
            await self.publish(
                EventType.BROKER_DRIFT,
                EventTier.FAST,
                {
                    "repaired_positions": repaired,
                    "reason": "Synced internal book with broker after external close",
                },
                dedupe_key=f"broker-drift:{self.session_id}:{int(time.time() // 60)}",
            )

        if capacity_available:
            await self.publish(
                EventType.STRATEGY_REVIEW,
                EventTier.FAST,
                {
                    "reason": "Portfolio capacity available — review watchlist for new entries",
                    "headroom_usd": round(headroom, 2),
                    "total_pnl": round(total_pnl, 2),
                    "open_watchlist_slots": open_slots,
                    "exposure_pct": round(float(stats["invested"]) / start * 100, 1)
                    if start > 0
                    else 0.0,
                },
                dedupe_key=f"portfolio-capacity:{self.session_id}:{int(time.time() // 120)}",
            )
            should_spawn = True
            try:
                await get_market_hunter().nudge_watchlist_tickers(open_slots)
            except Exception:
                pass

        oneline = (
            f"P/L {total_pnl:+.2f} · {len(open_positions)} open · "
            f"{headroom:.0f} headroom"
        )
        if open_slots and capacity_available:
            oneline += f" · slots: {', '.join(open_slots[:3])}"
        if repaired:
            oneline += f" · synced {repaired} with broker"
        if weakening:
            oneline += f" · {weakening} weakening"
        if breached:
            oneline += f" · {breached} stop breach"

        if profit_actions:
            oneline += f" · {profit_actions} profit action(s)"
        if rebuy_candidates:
            oneline += f" · rebuy: {', '.join(row['ticker'] for row in rebuy_candidates[:2])}"

        armed_levels = sum(
            1
            for plan in exit_plans.values()
            if isinstance(plan, dict) and plan.get("active")
        )

        return MonitorResult(
            data={
                "open_positions": len(open_positions),
                "weakening": weakening,
                "stop_breaches": breached,
                "headroom_usd": round(headroom, 2),
                "total_pnl": round(total_pnl, 2),
                "exposure_usd": float(stats["invested"]),
                "watchlist_open_slots": open_slots,
                "broker_drift_repaired": repaired,
                "profit_actions": profit_actions,
                "armed_exit_plans": armed_levels,
                "rebuy_candidates": rebuy_candidates,
            },
            should_spawn_sub_agent=should_spawn,
            status="degraded" if breached else "active",
            oneline=oneline,
        )


class RiskMonitor(PeriodicService):
    name = "risk_monitor"
    interval_key = "risk_monitor_seconds"
    card = "risk_monitor"

    async def tick(self, session: dict[str, Any]) -> MonitorResult:
        stats = self.store.session_stats(self.session_id)
        start = float(session.get("start_balance") or 0)
        config = session.get("config") or {}
        if start <= 0:
            return MonitorResult(status="idle", oneline="Awaiting start balance")
        daily_loss_pct = max(0.0, -float(stats["realized_pnl"]) / start * 100)
        exposure_pct = float(stats["invested"]) / start * 100
        max_daily = float(config.get("max_daily_loss_pct", 5))
        max_exposure = float(config.get("max_exposure_pct", 80))
        breached = False
        # Critical deterministic circuit breakers bypass the LLM entirely.
        if daily_loss_pct >= max_daily:
            breached = True
            await self.publish(
                EventType.DAILY_LOSS_LIMIT,
                EventTier.CRITICAL,
                {"reason": f"Daily loss {daily_loss_pct:.2f}% breached limit"},
                dedupe_key="daily-loss-circuit",
            )
        if exposure_pct > max_exposure:
            breached = True
            await self.publish(
                EventType.EXPOSURE_LIMIT,
                EventTier.CRITICAL,
                {"reason": f"Exposure {exposure_pct:.2f}% breached limit"},
                dedupe_key="exposure-circuit",
            )
        return MonitorResult(
            data={
                "daily_loss_pct": round(daily_loss_pct, 2),
                "exposure_pct": round(exposure_pct, 2),
                "max_daily_loss_pct": max_daily,
                "max_exposure_pct": max_exposure,
            },
            should_spawn_sub_agent=False,  # critical breakers act immediately, no spawn
            status="degraded" if breached else "active",
            oneline=(
                f"Daily loss {daily_loss_pct:.1f}%/{max_daily:.0f}% · "
                f"exposure {exposure_pct:.0f}%/{max_exposure:.0f}%"
            ),
        )


class NewsMonitor(PeriodicService):
    name = "news_monitor"
    interval_key = "news_monitor_seconds"
    card = "news_monitor"
    KEYWORDS = (
        "offering",
        "dilution",
        "bankruptcy",
        "chapter 11",
        "investigation",
        "restatement",
        "sec filing",
        "going concern",
        "delisting",
    )
    CRITICAL_FORMS = {"S-1", "S-3", "424B2", "424B3", "424B5", "8-K", "NT 10-K"}

    def __init__(self, session_id: str, store: Any, bus: Any) -> None:
        super().__init__(session_id, store, bus)
        self._last_filings_poll = 0.0

    async def tick(self, session: dict[str, Any]) -> MonitorResult:
        if not os.getenv("FINNHUB_API_KEY", "").strip():
            raise ServiceUnavailable("FINNHUB_API_KEY not configured")
        from control_plane.news_service import get_news_service

        critical_hits = 0

        poll_filings = (
            time.monotonic() - self._last_filings_poll
            >= float(
                (session.get("config") or {}).get(
                    "news_filings_seconds", DEFAULT_CONFIG["news_filings_seconds"]
                )
            )
        )
        for position in self.store.list_positions(self.session_id, states=("open",)):
            response = await get_news_service().company_news(position["ticker"], days=2)
            for item in (response.get("data") or [])[:10]:
                headline = str(item.get("headline") or "")
                text = f"{headline} {item.get('summary') or ''}".lower()
                hits = [keyword for keyword in self.KEYWORDS if keyword in text]
                if hits:
                    critical_hits += 1
                    item_id = str(item.get("id") or headline)
                    # Ask the orchestrator to spawn a news-analyst sub-agent.
                    await self.publish(
                        EventType.CRITICAL_NEWS,
                        EventTier.FAST,
                        {
                            "headline": headline,
                            "news_id": item_id,
                            "url": item.get("url"),
                            "critical_keywords": hits,
                        },
                        ticker=position["ticker"],
                        dedupe_key=f"news:{position['ticker']}:{item_id}",
                    )
            if poll_filings:
                filings = await get_news_service().sec_filings(
                    position["ticker"], days=7, limit=10
                )
                for filing in filings.get("data") or []:
                    form = str(filing.get("form") or "").upper()
                    if form not in self.CRITICAL_FORMS:
                        continue
                    access = str(
                        filing.get("accessNumber")
                        or filing.get("accessionNumber")
                        or filing.get("filedDate")
                        or form
                    )
                    critical_hits += 1
                    await self.publish(
                        EventType.CRITICAL_NEWS,
                        EventTier.FAST,
                        {
                            "headline": f"SEC filing {form}",
                            "filing": filing,
                            "critical_keywords": ["sec filing", form],
                        },
                        ticker=position["ticker"],
                        dedupe_key=f"filing:{position['ticker']}:{access}",
                    )
        if poll_filings:
            self._last_filings_poll = time.monotonic()
        open_count = len(self.store.list_positions(self.session_id, states=("open",)))
        return MonitorResult(
            data={"critical_hits": critical_hits, "positions_scanned": open_count},
            should_spawn_sub_agent=critical_hits > 0,
            status="degraded" if critical_hits else "active",
            oneline=(
                f"{critical_hits} critical headline(s) on held names"
                if critical_hits
                else f"No critical news · {open_count} position(s) scanned"
            ),
        )


class StrategyScheduler(PeriodicService):
    name = "strategy_scheduler"
    interval_key = "strategy_review_seconds"

    async def tick(self, session: dict[str, Any]) -> MonitorResult:
        # A scheduled strategic review asks the orchestrator to reason (spawn).
        await self.publish(
            EventType.STRATEGY_REVIEW,
            EventTier.STRATEGIC,
            {"reason": "Scheduled portfolio review"},
            dedupe_key=f"strategy:{int(datetime.now().timestamp() // 300)}",
        )
        return MonitorResult(
            data={"reason": "scheduled_portfolio_review"},
            should_spawn_sub_agent=True,
            status="active",
            oneline="Scheduled portfolio review queued",
        )


class PlaybookReviewer(PeriodicService):
    name = "playbook_reviewer"
    interval_key = "playbook_review_seconds"

    async def tick(self, session: dict[str, Any]) -> MonitorResult | None:
        positions = {
            row["id"]: row
            for row in self.store.list_positions(self.session_id, states=("open",))
        }

        def update(state: dict[str, Any]) -> None:
            for position_id, playbook in list(state.setdefault("playbooks", {}).items()):
                position = positions.get(position_id)
                if position:
                    state["playbooks"][position_id] = review_playbook(playbook, position)

        snapshot = self.snapshot.mutate(update)
        for position_id in snapshot.get("playbooks", {}):
            position = positions.get(position_id)
            if position:
                await self.publish(
                    EventType.PLAYBOOK_REVIEW,
                    EventTier.FAST if position.get("exit_state") == "weakening" else EventTier.OBSERVATION,
                    {"position_id": position_id},
                    ticker=position["ticker"],
                    dedupe_key=f"playbook:{position_id}:{int(datetime.now().timestamp() // 300)}",
                )


class ReconciliationAdapter(PeriodicService):
    name = "broker_reconciler"
    interval_key = "reconcile_interval_seconds"

    async def tick(self, session: dict[str, Any]) -> MonitorResult | None:
        from control_plane.agentic.reconciliation import reconcile_session_positions

        repaired = await reconcile_session_positions(session, self.store)
        if repaired:
            self._status("active", f"Repaired {repaired} position(s) vs broker")
        else:
            self._status("active", "Broker book in sync")
        return MonitorResult(
            data={"repaired_positions": repaired},
            oneline=(
                f"Synced {repaired} position(s) with broker"
                if repaired
                else "Broker book in sync"
            ),
        )


class ServiceLifecycleManager:
    def __init__(self, session_id: str, store: Any, bus: Any) -> None:
        self.session_id = session_id
        self.store = store
        self.bus = bus
        self.tasks: dict[str, asyncio.Task[Any]] = {}

    def start(self) -> None:
        services = (
            PositionMonitor,
            NewsMonitor,
            RiskMonitor,
            ReconciliationAdapter,
            StrategyScheduler,
            PlaybookReviewer,
        )
        for service_type in services:
            service = service_type(self.session_id, self.store, self.bus)
            task = asyncio.create_task(
                service.run(), name=f"agentic-{service.name}-{self.session_id[:8]}"
            )
            self.tasks[service.name] = task

    async def stop(self) -> None:
        for task in self.tasks.values():
            task.cancel()
        for task in self.tasks.values():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self.tasks.clear()

    def status(self) -> dict[str, str]:
        return {
            name: ("running" if not task.done() else "stopped")
            for name, task in self.tasks.items()
        }
