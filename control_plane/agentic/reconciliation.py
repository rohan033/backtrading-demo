"""Broker reconciliation loop for agentic sessions (don't trust acks).

One global asyncio loop that, every 45s (configurable), diffs each session's
internal position rows against the broker's actual portfolio:

- broker closed / internal open   -> mark closed, realized PnL from broker fills
- broker open / internal pending_close -> retry close, error event after 3 retries
- pending_open never confirmed    -> mark failed, capital released
- dry-run sessions skip broker polling entirely (simulated state is authoritative);
  passes are still logged at debug level.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.broker import (
    close_broker_position,
    fetch_broker_positions,
    find_broker_closed_trade,
)
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.session_store import get_agentic_session_store

log = logging.getLogger("backtrading")

# pending_open rows older than this without a broker match are treated as
# rejected/silently-failed orders.
PENDING_OPEN_TIMEOUT_SECONDS = 120.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _age_seconds(iso_ts: str | None) -> float:
    if not iso_ts:
        return 0.0
    try:
        then = datetime.fromisoformat(str(iso_ts))
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).total_seconds()
    except ValueError:
        return 0.0


class AgenticReconciler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        # position_id -> failed close retry count
        self._close_retries: dict[str, int] = {}

    @property
    def interval_seconds(self) -> float:
        return max(10.0, float(DEFAULT_CONFIG["reconcile_interval_seconds"]))

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="agentic-reconciler")
        log.info("[AGENTIC_RECON] Started (every %.0fs)", self.interval_seconds)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        log.info("[AGENTIC_RECON] Stopped")

    async def _run(self) -> None:
        while True:
            try:
                await self.reconcile_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.error("[AGENTIC_RECON] Pass failed: %s", exc, exc_info=True)
            await asyncio.sleep(self.interval_seconds)

    async def reconcile_once(self) -> None:
        store = get_agentic_session_store()
        sessions = await asyncio.to_thread(store.list_sessions)
        # Reconcile running sessions plus stopped sessions that still hold positions.
        for session in sessions:
            positions = store.list_positions(
                session["id"], states=("pending_open", "open", "pending_close")
            )
            if session["status"] != "running" and not positions:
                continue
            if not positions:
                continue
            config = session.get("config") or {}
            dry_run = bool(config.get("dry_run", DEFAULT_CONFIG["dry_run"]))
            if dry_run:
                self._reconcile_dry_run(session, positions)
            else:
                await self._reconcile_against_broker(session, positions)

    # ── Dry-run: simulated state is authoritative ──

    def _reconcile_dry_run(
        self, session: dict[str, Any], positions: list[dict[str, Any]]
    ) -> None:
        store = get_agentic_session_store()
        for position in positions:
            # A simulated pending_open/pending_close should settle instantly;
            # anything stuck means the engine died mid-transition — repair it.
            if position["state"] == "pending_open" and _age_seconds(
                position["updated_at"]
            ) > PENDING_OPEN_TIMEOUT_SECONDS:
                store.update_position(
                    position["id"],
                    {"state": "open", "opened_at": position["updated_at"]},
                )
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{position['ticker']} stuck pending_open repaired to open [dry-run]",
                    ticker=position["ticker"],
                    meta={"position_id": position["id"], "dry_run": True},
                )
            elif position["state"] == "pending_close" and _age_seconds(
                position["updated_at"]
            ) > PENDING_OPEN_TIMEOUT_SECONDS:
                buy = float(position["buy_price"] or 0.0)
                price = float(position["current_price"] or buy)
                units = float(position["units"] or 0.0)
                store.update_position(
                    position["id"],
                    {
                        "state": "closed",
                        "closed_at": _now_iso(),
                        "units": 0.0,
                        "unrealized_pnl": 0.0,
                        "realized_pnl": float(position["realized_pnl"] or 0.0)
                        + (price - buy) * units,
                    },
                )
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{position['ticker']} stuck pending_close settled as closed [dry-run]",
                    ticker=position["ticker"],
                    meta={"position_id": position["id"], "dry_run": True},
                )
        log.debug(
            "[AGENTIC_RECON] dry-run pass session=%s positions=%d ok",
            session["id"],
            len(positions),
        )

    # ── Real broker diff ──

    async def _reconcile_against_broker(
        self, session: dict[str, Any], positions: list[dict[str, Any]]
    ) -> None:
        store = get_agentic_session_store()
        try:
            broker_rows = await fetch_broker_positions(session["account_env"])
        except Exception as exc:
            log.warning(
                "[AGENTIC_RECON] Broker poll failed session=%s: %s", session["id"], exc
            )
            return
        broker_by_id: dict[str, dict[str, Any]] = {}
        for row in broker_rows:
            pid = row.get("positionID") or row.get("positionId")
            if pid is not None:
                broker_by_id[str(pid)] = row

        max_retries = int(
            (session.get("config") or {}).get(
                "reconcile_close_retries", DEFAULT_CONFIG["reconcile_close_retries"]
            )
        )

        for position in positions:
            broker_id = str(position.get("broker_position_id") or "")
            broker_row = broker_by_id.get(broker_id) if broker_id else None
            state = position["state"]

            if state == "open" and broker_id and broker_row is None:
                await self._settle_broker_closed(session, position)
            elif state == "pending_close" and broker_row is not None:
                await self._retry_close(session, position, max_retries)
            elif state == "pending_close" and broker_row is None:
                await self._settle_broker_closed(session, position)
            elif state == "pending_open":
                if broker_row is not None:
                    store.update_position(
                        position["id"],
                        {"state": "open", "opened_at": _now_iso()},
                    )
                    store.add_event(
                        session["id"],
                        "reconciliation",
                        f"{position['ticker']} confirmed open at broker",
                        ticker=position["ticker"],
                        meta={"position_id": position["id"], "broker_position_id": broker_id},
                    )
                elif _age_seconds(position["updated_at"]) > PENDING_OPEN_TIMEOUT_SECONDS:
                    # Rejected or silently failed: mark failed, release capital.
                    store.update_position(position["id"], {"state": "failed"})
                    store.add_event(
                        session["id"],
                        "reconciliation",
                        f"{position['ticker']} order never confirmed — marked failed, "
                        "allocated capital released",
                        ticker=position["ticker"],
                        meta={"position_id": position["id"], "intent_id": position["intent_id"]},
                    )

    async def _settle_broker_closed(
        self, session: dict[str, Any], position: dict[str, Any]
    ) -> None:
        """Broker shows closed, internal shows open/pending_close."""
        store = get_agentic_session_store()
        broker_id = str(position.get("broker_position_id") or "")
        realized = None
        fill: dict[str, Any] | None = None
        if broker_id:
            fill = await find_broker_closed_trade(
                session["account_env"], broker_position_id=broker_id
            )
        if fill:
            for key in ("netProfit", "netProfitUsd", "profit", "Profit"):
                if fill.get(key) is not None:
                    try:
                        realized = float(fill[key])
                    except (TypeError, ValueError):
                        realized = None
                    break
        if realized is None:
            # Never assume the fill price — but if history hasn't settled yet,
            # fall back to the last observed mark rather than blocking forever.
            buy = float(position["buy_price"] or 0.0)
            price = float(position["current_price"] or buy)
            realized = (price - buy) * float(position["units"] or 0.0)

        store.update_position(
            position["id"],
            {
                "state": "closed",
                "closed_at": _now_iso(),
                "units": 0.0,
                "unrealized_pnl": 0.0,
                "realized_pnl": float(position["realized_pnl"] or 0.0) + realized,
            },
        )
        store.add_event(
            session["id"],
            "reconciliation",
            f"{position['ticker']} closed at broker (internal was {position['state']}); "
            f"realized {realized:+.2f} from {'broker fill' if fill else 'last mark (fill pending)'}",
            ticker=position["ticker"],
            meta={
                "position_id": position["id"],
                "broker_position_id": broker_id,
                "realized_pnl_delta": realized,
                "fill_found": bool(fill),
            },
        )
        self._close_retries.pop(position["id"], None)

    async def _retry_close(
        self, session: dict[str, Any], position: dict[str, Any], max_retries: int
    ) -> None:
        """Broker still open while internal is pending_close: retry, then alert."""
        store = get_agentic_session_store()
        retries = self._close_retries.get(position["id"], 0)
        if retries >= max_retries:
            store.add_event(
                session["id"],
                "error",
                f"{position['ticker']} close failed {retries} time(s); "
                "manual intervention required",
                ticker=position["ticker"],
                meta={
                    "position_id": position["id"],
                    "broker_position_id": position.get("broker_position_id"),
                    "retries": retries,
                },
            )
            return
        self._close_retries[position["id"]] = retries + 1
        try:
            await close_broker_position(
                session["account_env"],
                position["ticker"],
                str(position.get("broker_position_id") or ""),
            )
            store.add_event(
                session["id"],
                "reconciliation",
                f"{position['ticker']} close retried (attempt {retries + 1})",
                ticker=position["ticker"],
                meta={"position_id": position["id"], "attempt": retries + 1},
            )
        except Exception as exc:
            store.add_event(
                session["id"],
                "reconciliation",
                f"{position['ticker']} close retry {retries + 1} failed: {exc}",
                ticker=position["ticker"],
                meta={"position_id": position["id"], "attempt": retries + 1},
            )


_reconciler: AgenticReconciler | None = None


def get_agentic_reconciler() -> AgenticReconciler:
    global _reconciler
    if _reconciler is None:
        _reconciler = AgenticReconciler()
    return _reconciler
