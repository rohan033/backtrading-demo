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
import time
from datetime import datetime, timezone
from typing import Any

from control_plane.agentic.broker import (
    broker_open_position_sync_fields,
    fetch_broker_open_index,
    fetch_broker_position_row,
    find_broker_closed_trade,
)
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.etoro_trace import agentic_etoro_trace
from control_plane.agentic.halt_execution import get_halted_symbols
from control_plane.agentic.session_store import get_agentic_session_store
from control_plane.etoro_close_settle import settled_fields_from_closed_trade

log = logging.getLogger("backtrading")

# pending_open rows older than this without a broker match are treated as
# rejected/silently-failed orders.
PENDING_OPEN_TIMEOUT_SECONDS = 120.0
# Stop polling trade/history for very old closes (eToro retention varies).
CLOSED_SETTLEMENT_MAX_AGE_SECONDS = 7 * 24 * 3600.0
# Ignore tiny float drift when syncing open positions from broker.
_OPEN_SYNC_TOLERANCE = {
    "units": 0.0001,
    "buy_price": 0.0002,
    "current_price": 0.0002,
    "unrealized_pnl": 0.05,
    "stop_loss": 0.0002,
}


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
    # When we know the broker position id, only trust an exact id match.
    # Ticker fallback wrongly treats a different open row as "still open".
    if broker_id:
        return by_id.get(broker_id)
    ticker = str(position.get("ticker") or "").upper()
    rows = by_ticker.get(ticker) or []
    # Ambiguous when several broker rows share a ticker — do not guess.
    return rows[0] if len(rows) == 1 else None


def _release_hunter_ticker(ticker: str) -> None:
    try:
        from control_plane.agentic.market_hunter import get_market_hunter

        get_market_hunter().clear_suggestion_cooldown(ticker)
    except Exception:
        pass


def _broker_pnl_from_fill(fill: dict[str, Any]) -> float | None:
    settled = settled_fields_from_closed_trade(fill)
    if settled and settled.get("pnl") is not None:
        return float(settled["pnl"])
    for key in ("netProfit", "netProfitUsd", "profit", "Profit"):
        if fill.get(key) is not None:
            try:
                return float(fill[key])
            except (TypeError, ValueError):
                continue
    return None


def _persist_settled_trade(
    session: dict[str, Any],
    position: dict[str, Any],
    settled: dict[str, Any],
    *,
    close_reason: str | None = None,
) -> None:
    broker_id = str(position.get("broker_position_id") or "")
    if not broker_id:
        return
    try:
        from control_plane.trades_pnl_store import get_trades_pnl_store

        get_trades_pnl_store().record_completed_ui_trade(
            position_id=broker_id,
            source="agentic",
            broker="etoro",
            account_env=session.get("account_env") or "demo",
            symbol=position.get("ticker"),
            entry_price=settled.get("buy_price"),
            exit_price=settled.get("sell_price"),
            pnl=settled.get("pnl"),
            pnl_pct=settled.get("pnl_pct"),
            close_reason=close_reason,
            order_id=settled.get("order_id"),
            quantity=settled.get("units"),
            capital=settled.get("investment"),
            opened_at=position.get("opened_at"),
            closed_at=position.get("closed_at"),
            session_id=session["id"],
        )
    except Exception as exc:
        log.warning(
            "[AGENTIC_RECON] trades_pnl write failed position=%s: %s",
            position.get("id"),
            exc,
        )


async def apply_broker_settlement(
    session: dict[str, Any],
    position: dict[str, Any],
    store: Any,
    *,
    fill: dict[str, Any] | None = None,
    reason: str = "broker trade history",
) -> bool:
    """Replace estimated realized P&L with eToro trade/history when available."""
    broker_id = str(position.get("broker_position_id") or "")
    if not broker_id:
        return False
    meta = dict(position.get("meta") or {})
    if meta.get("fill_settled"):
        return False

    if fill is None:
        fill = await find_broker_closed_trade(
            session["account_env"], broker_position_id=broker_id
        )
    if not fill:
        return False

    settled = settled_fields_from_closed_trade(fill)
    broker_pnl = _broker_pnl_from_fill(fill)
    if broker_pnl is None and settled and settled.get("pnl") is not None:
        broker_pnl = float(settled["pnl"])
    if broker_pnl is None:
        return False

    prior_estimated = float(position.get("realized_pnl") or 0.0)
    store.update_position(
        position["id"],
        {
            "realized_pnl": round(broker_pnl, 4),
            "meta": {
                "fill_settled": True,
                "broker_pnl": round(broker_pnl, 4),
                "estimated_pnl": round(prior_estimated, 4),
                "pnl_correction": round(broker_pnl - prior_estimated, 4),
                "settled_at": _now_iso(),
                "settled_from": "trade_history",
            },
        },
    )
    if settled:
        _persist_settled_trade(session, position, settled, close_reason=reason)
    store.add_event(
        session["id"],
        "reconciliation",
        f"{position['ticker']} P&L settled from eToro: "
        f"{broker_pnl:+.2f} (was {prior_estimated:+.2f}, "
        f"Δ{broker_pnl - prior_estimated:+.2f})",
        ticker=position["ticker"],
        meta={
            "position_id": position["id"],
            "broker_position_id": broker_id,
            "broker_pnl": broker_pnl,
            "estimated_pnl": prior_estimated,
            "fill_settled": True,
            "reason": reason,
        },
    )
    return True


async def reconcile_closed_positions(
    session: dict[str, Any],
    store: Any | None = None,
) -> int:
    """Backfill closed rows from eToro trade/history so dashboard profit matches broker."""
    store = store or get_agentic_session_store()
    config = session.get("config") or {}
    if bool(config.get("dry_run", DEFAULT_CONFIG["dry_run"])):
        return 0

    settled_count = 0
    pending = store.list_closed_needing_settlement(session["id"], limit=50)
    for position in pending:
        if _age_seconds(position.get("closed_at")) > CLOSED_SETTLEMENT_MAX_AGE_SECONDS:
            store.update_position(
                position["id"],
                {
                    "meta": {
                        "fill_settled": True,
                        "settled_from": "expired",
                        "settled_at": _now_iso(),
                    },
                },
            )
            continue
        if await apply_broker_settlement(session, position, store):
            settled_count += 1
    return settled_count


def _field_changed(key: str, old: Any, new: Any) -> bool:
    if old is None:
        return True
    try:
        old_f = float(old)
        new_f = float(new)
    except (TypeError, ValueError):
        return old != new
    tol = _OPEN_SYNC_TOLERANCE.get(key, 0.0001)
    return abs(old_f - new_f) > tol


def _sync_open_position_from_broker(
    session: dict[str, Any],
    position: dict[str, Any],
    broker_row: dict[str, Any],
    store: Any,
    *,
    reason: str = "synced from eToro",
    log_event: bool = True,
) -> int:
    """Refresh units, entry, mark, and unrealized P&L from eToro /pnl."""
    sync = broker_open_position_sync_fields(broker_row)
    if not sync:
        return 0

    updates: dict[str, Any] = {}
    changed_keys: list[str] = []
    for key, value in sync.items():
        if _field_changed(key, position.get(key), value):
            updates[key] = value
            changed_keys.append(key)

    updates["meta"] = {
        "broker_synced": True,
        "broker_synced_at": _now_iso(),
    }
    store.update_position(position["id"], updates)

    if not log_event:
        return 1 if changed_keys or updates.get("meta") else 0

    if not changed_keys:
        return 0

    ticker = str(position.get("ticker") or "")
    parts: list[str] = []
    if "units" in changed_keys:
        parts.append(f"units {position.get('units')}→{sync.get('units')}")
    if "buy_price" in changed_keys:
        parts.append(
            f"entry {float(position.get('buy_price') or 0):.4f}"
            f"→{float(sync.get('buy_price') or 0):.4f}"
        )
    if "current_price" in changed_keys:
        parts.append(
            f"mark {float(position.get('current_price') or 0):.4f}"
            f"→{float(sync.get('current_price') or 0):.4f}"
        )
    if "unrealized_pnl" in changed_keys:
        parts.append(
            f"uP&L {float(position.get('unrealized_pnl') or 0):+.2f}"
            f"→{float(sync.get('unrealized_pnl') or 0):+.2f}"
        )

    store.add_event(
        session["id"],
        "reconciliation",
        f"{ticker} {reason}: {', '.join(parts) or 'fields updated'}",
        ticker=ticker,
        meta={
            "position_id": position["id"],
            "broker_position_id": position.get("broker_position_id"),
            "changed": changed_keys,
            "sync": sync,
        },
    )
    return 1


async def refresh_open_position_from_broker(
    session: dict[str, Any],
    position: dict[str, Any],
    store: Any | None = None,
    *,
    attempts: int = 10,
    delay_sec: float = 1.5,
    reason: str = "fill confirmed from eToro",
) -> dict[str, Any]:
    """Poll /pnl after order placement until broker fill fields are available."""
    store = store or get_agentic_session_store()
    broker_id = str(position.get("broker_position_id") or "")
    if not broker_id:
        return position

    account_env = session["account_env"]
    last_row: dict[str, Any] | None = None
    for attempt in range(max(1, attempts)):
        row = await fetch_broker_position_row(account_env, broker_id)
        if row:
            last_row = row
            sync = broker_open_position_sync_fields(row)
            if (
                sync
                and sync.get("buy_price")
                and sync.get("units")
                and sync.get("current_price")
            ):
                _sync_open_position_from_broker(
                    session,
                    position,
                    row,
                    store,
                    reason=reason,
                )
                return store.get_position(position["id"]) or position
        if attempt + 1 < attempts:
            await asyncio.sleep(delay_sec)

    if last_row:
        _sync_open_position_from_broker(
            session,
            position,
            last_row,
            store,
            reason=reason,
        )
        return store.get_position(position["id"]) or position
    return position


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
        broker_pnl = _broker_pnl_from_fill(fill)
        if broker_pnl is not None:
            realized = broker_pnl

    if realized is None:
        buy = float(position["buy_price"] or 0.0)
        price = float(position["current_price"] or buy)
        realized = (price - buy) * float(position["units"] or 0.0)

    prior_estimated = float(position.get("realized_pnl") or 0.0)
    final_pnl = float(realized) if fill else prior_estimated + float(realized)

    store.update_position(
        position["id"],
        {
            "state": "closed",
            "closed_at": _now_iso(),
            "units": 0.0,
            "unrealized_pnl": 0.0,
            "realized_pnl": final_pnl,
            "meta": {
                "fill_settled": bool(fill),
                "broker_pnl": round(final_pnl, 4) if fill else None,
                "estimated_pnl": round(prior_estimated, 4),
                "settled_at": _now_iso() if fill else None,
                "settled_from": "trade_history" if fill else "estimated",
            },
        },
    )
    if fill:
        settled = settled_fields_from_closed_trade(fill)
        if settled:
            _persist_settled_trade(
                session,
                {**position, "closed_at": _now_iso()},
                settled,
                close_reason=reason,
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
    halted_symbols = get_halted_symbols()

    for position in positions:
        state = position["state"]
        broker_row = _position_at_broker(position, broker_index)
        broker_id = str(position.get("broker_position_id") or "")
        ticker = str(position.get("ticker") or "").upper()

        if state in ("pending_open", "pending_close"):
            if ticker in halted_symbols:
                if not position.get("halt_suspended"):
                    store.update_position(position["id"], {"halt_suspended": True})
                    store.add_event(
                        session["id"],
                        "reconciliation",
                        f"{ticker} reconciliation paused — ticker halted",
                        ticker=ticker,
                        meta={
                            "position_id": position["id"],
                            "halt_suspended": True,
                            "state": state,
                        },
                    )
                    repaired += 1
                continue
            if position.get("halt_suspended"):
                store.update_position(position["id"], {"halt_suspended": False})
                position = {**position, "halt_suspended": False}
                store.add_event(
                    session["id"],
                    "reconciliation",
                    f"{ticker} halt lifted — immediate reconciliation",
                    ticker=ticker,
                    meta={"position_id": position["id"], "halt_suspended": False},
                )

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
                        position = store.get_position(position["id"]) or position
                if state == "open":
                    repaired += _sync_open_position_from_broker(
                        session, position, broker_row, store
                    )
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
                refreshed = store.get_position(position["id"]) or position
                await refresh_open_position_from_broker(
                    session,
                    refreshed,
                    store,
                    attempts=6,
                    reason="confirmed open at broker",
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
                if position.get("halt_suspended"):
                    continue
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
    config = session.get("config") or {}
    dry_run = bool(config.get("dry_run", DEFAULT_CONFIG["dry_run"]))

    closed_settled = 0
    if not dry_run:
        with agentic_etoro_trace(session["id"], source="closed_pnl_reconciliation"):
            closed_settled = await reconcile_closed_positions(session, store)

    positions = store.list_positions(
        session["id"], states=("pending_open", "open", "pending_close")
    )
    if not positions:
        return closed_settled
    if dry_run:
        _reconcile_dry_run(session, positions, store)
        return closed_settled
    reconciler = get_agentic_reconciler()
    with agentic_etoro_trace(session["id"], source="reconciliation"):
        open_repaired = await reconcile_session_against_broker(
            session,
            positions,
            store,
            close_retries=reconciler._close_retries,
        )
    return open_repaired + closed_settled


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
            pending_closed = store.list_closed_needing_settlement(session["id"], limit=20)
            if session["status"] != "running" and not positions and not pending_closed:
                continue
            if not positions and not pending_closed:
                continue
            await reconcile_session_positions(session, store)


_reconciler: AgenticReconciler | None = None
_snapshot_reconcile_last: dict[str, float] = {}
SNAPSHOT_RECONCILE_MIN_INTERVAL = 5.0


async def maybe_reconcile_for_snapshot(session_id: str) -> None:
    """Light broker sync before dashboard reads (throttled per session)."""
    now = time.monotonic()
    last = _snapshot_reconcile_last.get(session_id, 0.0)
    if now - last < SNAPSHOT_RECONCILE_MIN_INTERVAL:
        return
    _snapshot_reconcile_last[session_id] = now
    store = get_agentic_session_store()
    session = store.get_session(session_id)
    if session is None:
        return
    await reconcile_session_positions(session, store)


def get_agentic_reconciler() -> AgenticReconciler:
    global _reconciler
    if _reconciler is None:
        _reconciler = AgenticReconciler()
    return _reconciler
