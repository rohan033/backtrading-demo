"""Broker reconciliation loop for agentic sessions (don't trust acks).

One global asyncio loop that, every 45s (configurable), diffs each session's
internal position rows against the broker's actual portfolio:

- broker closed / internal open   -> mark closed, release capital, re-enable hunter
- broker open / internal pending_close -> mark ambiguous for manual reconciliation
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
    fetch_broker_open_index,
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


def _broker_row_id(row: dict[str, Any]) -> str:
    pid = row.get("positionID") or row.get("positionId")
    return str(pid) if pid is not None else ""


def _position_at_broker(
    position: dict[str, Any],
    broker_index: dict[str, Any],
) -> dict[str, Any] | None:
    broker_id = str(position.get("broker_position_id") or "")
    by_id: dict[str, dict[str, Any]] = broker_index.get("by_id") or {}
    by_ticker: dict[str, list[dict[str, Any]]] = broker_index.get("by_ticker") or {}
    if broker_id and broker_id in by_id:
        return by_id[broker_id]
    ticker = str(position.get("ticker") or "").upper()
    rows = by_ticker.get(ticker) or []
    return rows[0] if rows else None


def _release_hunter_ticker(ticker: str) -> None:
    try:
        from control_plane.agentic.market_hunter import get_market_hunter

        get_market_hunter().clear_suggestion_cooldown(ticker)
    except Exception:
        pass


async def _settle_broker_closed(
    session: dict[str, Any],
    position: dict[str, Any],
    store: Any,
    *,
    close_retries: dict[str, int],
    reason: str = "broker closed",
) -> None:
    """Broker shows closed, internal shows open/pending_close."""
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
        f"{position['ticker']} closed at broker ({reason}; internal was "
        f"{position['state']}); realized {realized:+.2f} from "
        f"{'broker fill' if fill else 'last mark (fill pending)'}",
        ticker=position["ticker"],
        meta={
            "position_id": position["id"],
            "broker_position_id": broker_id or None,
            "realized_pnl_delta": realized,
            "fill_found": bool(fill),
            "reason": reason,
        },
    )
    close_retries.pop(position["id"], None)
    _release_hunter_ticker(str(position.get("ticker") or ""))


def _mark_close_ambiguous(
    session: dict[str, Any],
    position: dict[str, Any],
    store: Any,
    *,
    close_retries: dict[str, int],
) -> None:
    """Never resend an ambiguous execution request; surface it for reconciliation."""
    if close_retries.get(position["id"]):
        return
    close_retries[position["id"]] = 1
    store.add_event(
        session["id"],
        "error",
        f"{position['ticker']} close outcome is ambiguous; request was not retried. "
        "Broker state remains open and requires reconciliation.",
        ticker=position["ticker"],
        meta={
            "position_id": position["id"],
            "broker_position_id": position.get("broker_position_id"),
            "outcome": "ambiguous",
            "at_most_once": True,
        },
    )


async def reconcile_session_against_broker(
    session: dict[str, Any],
    positions: list[dict[str, Any]],
    store: Any,
    *,
    close_retries: dict[str, int] | None = None,
) -> int:
    """Diff one session against the broker. Returns count of repaired rows."""
    if not positions:
        return 0
    retries = close_retries if close_retries is not None else {}
    try:
        broker_index = await fetch_broker_open_index(session["account_env"])
    except Exception as exc:
        log.warning(
            "[AGENTIC_RECON] Broker poll failed session=%s: %s", session["id"], exc
        )
        return 0

    by_id: dict[str, dict[str, Any]] = broker_index.get("by_id") or {}
    repaired = 0

    for position in positions:
        state = position["state"]
        broker_row = _position_at_broker(position, broker_index)
        broker_id = str(position.get("broker_position_id") or "")
        ticker = str(position.get("ticker") or "").upper()

        if state in ("open", "pending_close"):
            if broker_row is not None:
                if not broker_id:
                    pid = _broker_row_id(broker_row)
                    if pid:
                        store.update_position(
                            position["id"],
                            {
                                "state": "open",
                                "broker_position_id": pid,
                                "opened_at": position.get("opened_at") or _now_iso(),
                            },
                        )
                        store.add_event(
                            session["id"],
                            "reconciliation",
                            f"{ticker} linked to broker position {pid}",
                            ticker=ticker,
                            meta={"position_id": position["id"], "broker_position_id": pid},
                        )
                        repaired += 1
                elif state == "pending_close":
                    _mark_close_ambiguous(session, position, store, close_retries=retries)
                continue

            await _settle_broker_closed(
                session,
                position,
                store,
                close_retries=retries,
                reason="manual or external close detected",
            )
            repaired += 1
            continue

        if state == "pending_open":
            if broker_row is not None:
                pid = _broker_row_id(broker_row)
                store.update_position(
                    position["id"],
                    {
                        "state": "open",
                        "opened_at": _now_iso(),
                        "broker_position_id": pid or position.get("broker_position_id"),
                    },
                )
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{ticker} confirmed open at broker",
                    ticker=ticker,
                    meta={
                        "position_id": position["id"],
                        "broker_position_id": pid or broker_id or None,
                    },
                )
                repaired += 1
            elif broker_id and broker_id in by_id:
                store.update_position(
                    position["id"],
                    {"state": "open", "opened_at": _now_iso()},
                )
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{ticker} confirmed open at broker",
                    ticker=ticker,
                    meta={"position_id": position["id"], "broker_position_id": broker_id},
                )
                repaired += 1
            elif _age_seconds(position["updated_at"]) > PENDING_OPEN_TIMEOUT_SECONDS:
                store.update_position(position["id"], {"state": "failed"})
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{ticker} order never confirmed — marked failed, "
                    "allocated capital released",
                    ticker=ticker,
                    meta={"position_id": position["id"], "intent_id": position["intent_id"]},
                )
                _release_hunter_ticker(ticker)
                repaired += 1

    return repaired


async def reconcile_session_positions(session: dict[str, Any], store: Any | None = None) -> int:
    """Reconcile one session; used by the global loop and portfolio monitor."""
    store = store or get_agentic_session_store()
    positions = store.list_positions(
        session["id"], states=("pending_open", "open", "pending_close")
    )
    if not positions:
        return 0
    config = session.get("config") or {}
    dry_run = bool(config.get("dry_run", DEFAULT_CONFIG["dry_run"]))
    if dry_run:
        _reconcile_dry_run(session, positions, store)
        return 0
    reconciler = get_agentic_reconciler()
    return await reconcile_session_against_broker(
        session,
        positions,
        store,
        close_retries=reconciler._close_retries,
    )


def _reconcile_dry_run(
    session: dict[str, Any], positions: list[dict[str, Any]], store: Any
) -> None:
    for position in positions:
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
            _release_hunter_ticker(str(position.get("ticker") or ""))
    log.debug(
        "[AGENTIC_RECON] dry-run pass session=%s positions=%d ok",
        session["id"],
        len(positions),
    )


class AgenticReconciler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
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
        for session in sessions:
            positions = store.list_positions(
                session["id"], states=("pending_open", "open", "pending_close")
            )
            if session["status"] != "running" and not positions:
                continue
            if not positions:
                continue
            await reconcile_session_positions(session, store)


_reconciler: AgenticReconciler | None = None


def get_agentic_reconciler() -> AgenticReconciler:
    global _reconciler
    if _reconciler is None:
        _reconciler = AgenticReconciler()
    return _reconciler
