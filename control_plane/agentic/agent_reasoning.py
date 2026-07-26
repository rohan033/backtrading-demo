"""LLM reasoning streams for agentic hunter + session agents."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

from control_plane.agentic.agent_contract import emit_agent_response, one_line
from control_plane.agentic.agent_store_adapter import AgenticAgentStoreAdapter
from control_plane.agentic.config import DEFAULT_CONFIG
from control_plane.agentic.session_store import get_agentic_session_store
from control_plane.agentic.snapshot import SessionSnapshot

log = logging.getLogger("backtrading")

_hunter_tasks: dict[str, asyncio.Task] = {}
_session_tasks: dict[str, asyncio.Task] = {}
_task_lock = asyncio.Lock()
_hunter_last_thinking_at: dict[str, float] = {}
_hunter_last_fingerprint: dict[str, str] = {}
_hunter_last_emitted_tickers: dict[str, set[str]] = {}

_HUNTER_THINKING_MIN_BURST_SECONDS = 120.0


def _cursor_enabled() -> bool:
    return bool(os.getenv("CURSOR_API_KEY", "").strip())


def _emit_synthetic(
    session_id: str,
    *,
    agent: str,
    lines: list[str],
    ticker: str | None = None,
) -> None:
    store = get_agentic_session_store()
    cleaned: list[str] = []
    for line in lines:
        summary = " ".join(line.split())
        if not summary:
            continue
        if len(summary) > 180:
            cut = summary[:179]
            if " " in cut:
                cut = cut.rsplit(" ", 1)[0]
            summary = cut.rstrip() + "…"
        cleaned.append(summary)
        store.add_event(
            session_id,
            "thinking",
            summary,
            ticker=ticker,
            meta={"agent": agent, "synthetic": True, "kind": "summary"},
        )
    if cleaned:
        # Also surface a complete (non-streamed) thinking block for the accordion.
        try:
            SessionSnapshot(store, session_id).record_thinking_summary(
                uuid.uuid4().hex,
                agent=agent,
                text="\n".join(cleaned),
                ticker=ticker,
            )
        except Exception:
            pass


def _hunter_prompt(
    session: dict[str, Any],
    *,
    candidates_count: int,
    emitted: list[dict[str, Any]],
    manual_tickers: list[str],
) -> str:
    prompt = (session.get("prompt") or "").strip()
    config = session.get("config") or {}
    watchlist = [str(t).upper() for t in (config.get("tickers") or []) if t]
    screener_ids = config.get("screener_ids") or []

    emitted_lines = [
        f"- {s['ticker']}: score {s['score']} ({s.get('reason') or s.get('source_screener')})"
        for s in emitted[:12]
    ] or ["- (none above threshold this scan)"]

    if watchlist and not screener_ids:
        screener_scope = "watchlist only — ignore all other screener names"
    elif not screener_ids:
        screener_scope = "all screeners"
    else:
        screener_scope = f"{len(screener_ids)} selected screeners"

    focus_rule = (
        f"ONLY discuss these watchlist tickers: {', '.join(watchlist)}. "
        "Do not mention or recommend any other symbols."
        if watchlist and not screener_ids
        else "Prefer watchlist names when present; otherwise summarize the strongest screener suggestions."
    )

    return f"""You are the background market hunter for an agentic trading session.

Session prompt: {prompt or "(none)"}
Account: {session.get("account_env", "demo")} · simulated: {bool(config.get("dry_run", False))}
Watchlist tickers: {", ".join(watchlist) or "none"}
Manual scope tickers this scan: {", ".join(manual_tickers) or "none"}
Screener filter: {screener_scope}
Focus rule: {focus_rule}

Scan results: {candidates_count} candidates in scope, {len(emitted)} suggestion(s) emitted.
Top suggestions:
{chr(10).join(emitted_lines)}

In 1–2 plain sentences, explain what you are watching and which names look strongest. Plain text only — no JSON, no markdown fences, no UI components. Do NOT place orders. Obey the focus rule above."""


def _session_prompt(
    session: dict[str, Any],
    suggestion: dict[str, Any],
    *,
    price: float,
    atr: float | None,
    allocation: float,
    headroom: float,
) -> str:
    prompt = (session.get("prompt") or "").strip()
    config = session.get("config") or {}
    threshold = float(config.get("confidence_threshold", 60))

    watchlist = [str(t).upper() for t in (config.get("tickers") or []) if t]
    screener_ids = config.get("screener_ids") or []
    focus_rule = (
        f"This session is watchlist-only ({', '.join(watchlist)}). "
        "If the candidate is not on that list, say it is out of scope."
        if watchlist and not screener_ids
        else "Follow the session prompt and risk caps."
    )

    return f"""You are the session trading agent evaluating one candidate.

Session prompt: {prompt or "(none)"}
Candidate: {suggestion.get("ticker")} · hunter score {suggestion.get("score")}
Reason: {suggestion.get("reason") or suggestion.get("source_screener")}
Price: {price:.4f} · ATR: {atr or "n/a"} · threshold {threshold}
Sizing preview: ${allocation:.2f} allocation · ${headroom:.2f} headroom
simulated: {bool(config.get("dry_run", False))}
Focus rule: {focus_rule}

In 1–2 plain sentences, explain whether this entry fits session rules and risk caps. Plain text only — no JSON, no markdown, no UI. Do NOT place orders."""


def _hunter_scan_fingerprint(
    *,
    candidates_count: int,
    emitted: list[dict[str, Any]],
    manual_tickers: list[str],
) -> str:
    parts: list[str] = [str(candidates_count)]
    for suggestion in sorted(emitted, key=lambda row: str(row.get("ticker") or "")):
        parts.append(f"{suggestion.get('ticker')}:{suggestion.get('score')}")
    parts.append(",".join(sorted(manual_tickers)))
    return "|".join(parts)


def _mark_hunter_thinking_run(
    session_id: str,
    *,
    fingerprint: str,
    emitted: list[dict[str, Any]],
) -> None:
    _hunter_last_thinking_at[session_id] = time.monotonic()
    _hunter_last_fingerprint[session_id] = fingerprint
    seen = set(_hunter_last_emitted_tickers.get(session_id, set()))
    for suggestion in emitted:
        ticker = str(suggestion.get("ticker") or "").upper()
        if ticker:
            seen.add(ticker)
    _hunter_last_emitted_tickers[session_id] = seen


def should_schedule_hunter_thinking(
    session: dict[str, Any],
    *,
    candidates_count: int,
    emitted: list[dict[str, Any]],
    manual_tickers: list[str],
) -> bool:
    """Run hunter LLM on first scan, new monitor emissions, or material scan changes."""
    session_id = session["id"]
    config = session.get("config") or {}
    cooldown = float(
        config.get(
            "hunter_thinking_cooldown_seconds",
            DEFAULT_CONFIG["hunter_thinking_cooldown_seconds"],
        )
    )
    fingerprint = _hunter_scan_fingerprint(
        candidates_count=candidates_count,
        emitted=emitted,
        manual_tickers=manual_tickers,
    )
    now = time.monotonic()
    last_at = _hunter_last_thinking_at.get(session_id, 0.0)
    last_fingerprint = _hunter_last_fingerprint.get(session_id)
    last_tickers = _hunter_last_emitted_tickers.get(session_id, set())

    if last_at == 0.0:
        return True

    elapsed = now - last_at
    new_tickers = {
        str(suggestion.get("ticker") or "").upper()
        for suggestion in emitted
        if suggestion.get("ticker")
    } - last_tickers

    if new_tickers and elapsed >= _HUNTER_THINKING_MIN_BURST_SECONDS:
        return True

    if elapsed < cooldown:
        return False

    return fingerprint != last_fingerprint


async def run_hunter_thinking(
    session: dict[str, Any],
    *,
    candidates_count: int,
    emitted: list[dict[str, Any]],
    manual_tickers: list[str],
) -> None:
    session_id = session["id"]
    store = get_agentic_session_store()
    current = store.get_session(session_id)
    if not current or current.get("status") != "running":
        return

    fingerprint = _hunter_scan_fingerprint(
        candidates_count=candidates_count,
        emitted=emitted,
        manual_tickers=manual_tickers,
    )
    _mark_hunter_thinking_run(session_id, fingerprint=fingerprint, emitted=emitted)

    top = ", ".join(f"{s['ticker']}({s['score']})" for s in emitted[:4]) or "none"
    if not _cursor_enabled():
        _emit_synthetic(
            session_id,
            agent="hunter",
            lines=[
                f"Hunter scan: {candidates_count} candidates, {len(emitted)} suggestion(s).",
                f"Watchlist: {', '.join(manual_tickers) or 'none'}.",
                *[
                    f"{s['ticker']} score {s['score']}: {s.get('reason', '')}"
                    for s in emitted[:4]
                ],
            ],
        )
        emit_agent_response(
            store,
            session_id,
            agent="hunter",
            data=(
                f"Scanned {candidates_count} candidate(s); emitted {len(emitted)} suggestion(s). "
                f"Strongest: {top}."
            ),
            oneline=(
                f"Selected {top} for trading"
                if emitted
                else "Waiting for hunter for suggestions"
            ),
            confidence=0.55 if emitted else 0.3,
            tier="fast",
        )
        return

    from control_plane.agentic.agent_stream import stream_agentic_prompt

    adapter = AgenticAgentStoreAdapter(store, agent="hunter")
    prompt = _hunter_prompt(
        session,
        candidates_count=candidates_count,
        emitted=emitted,
        manual_tickers=manual_tickers,
    )
    try:
        text = await stream_agentic_prompt(
            session_id=session_id,
            store=adapter,
            state="hunting",
            prompt=prompt,
            interaction_mode="analyze",
            web_search_enabled=False,
        )
        emit_agent_response(
            store,
            session_id,
            agent="hunter",
            data=text or f"Scanned {candidates_count} candidate(s), {len(emitted)} emitted.",
            oneline=one_line(text) or (f"Selected {top} for trading" if emitted else "Waiting for hunter for suggestions"),
            confidence=0.6 if emitted else 0.35,
            tier="fast",
        )
    except Exception as exc:
        log.warning("[AGENTIC_HUNTER] thinking failed: %s", exc)
        _emit_synthetic(
            session_id,
            agent="hunter",
            lines=[f"Hunter reasoning error: {exc}"],
        )


async def run_session_thinking(
    session: dict[str, Any],
    suggestion: dict[str, Any],
    *,
    price: float,
    atr: float | None,
    allocation: float,
    headroom: float,
) -> None:
    session_id = session["id"]
    ticker = str(suggestion.get("ticker") or "")
    store = get_agentic_session_store()
    current = store.get_session(session_id)
    if not current or current.get("status") != "running":
        return

    if not _cursor_enabled():
        _emit_synthetic(
            session_id,
            agent="session",
            ticker=ticker,
            lines=[
                f"Evaluating {ticker}: score {suggestion.get('score')}, price {price:.4f}.",
                f"Allocation ~${allocation:.2f}; stop via {'ATR' if atr else '5% fallback'}.",
            ],
        )
        emit_agent_response(
            store,
            session_id,
            agent="session",
            data=(
                f"Evaluated {ticker} at {price:.4f} (score {suggestion.get('score')}). "
                f"Sizing ~${allocation:.2f} within ${headroom:.2f} headroom; "
                f"stop via {'ATR' if atr else '5% fallback'}."
            ),
            oneline=f"Evaluated {ticker} for entry",
            confidence=min(0.9, max(0.4, float(suggestion.get("score") or 50) / 100)),
            tier="fast",
            ticker=ticker,
        )
        return

    from control_plane.agentic.agent_stream import stream_agentic_prompt

    adapter = AgenticAgentStoreAdapter(store, agent="session")
    prompt = _session_prompt(
        session,
        suggestion,
        price=price,
        atr=atr,
        allocation=allocation,
        headroom=headroom,
    )
    try:
        text = await stream_agentic_prompt(
            session_id=session_id,
            store=adapter,
            state="evaluating",
            prompt=prompt,
            interaction_mode="analyze",
            web_search_enabled=False,
        )
        emit_agent_response(
            store,
            session_id,
            agent="session",
            data=text or f"Evaluated {ticker} at {price:.4f}.",
            oneline=one_line(text) or f"Evaluated {ticker} for entry",
            confidence=min(0.9, max(0.4, float(suggestion.get("score") or 50) / 100)),
            tier="fast",
            ticker=ticker,
        )
    except Exception as exc:
        log.warning("[AGENTIC_SESSION] thinking failed for %s: %s", ticker, exc)
        _emit_synthetic(
            session_id,
            agent="session",
            ticker=ticker,
            lines=[f"Session reasoning error for {ticker}: {exc}"],
        )


def _subagents_halted(session: dict[str, Any]) -> bool:
    try:
        return SessionSnapshot(get_agentic_session_store(), session["id"]).subagents_halted()
    except Exception:
        return False


async def cancel_session_agent_tasks(session_id: str) -> int:
    """Cancel in-flight hunter/session thinking tasks for a session."""
    cancelled = 0
    async with _task_lock:
        hunter = _hunter_tasks.pop(session_id, None)
        if hunter and not hunter.done():
            hunter.cancel()
            cancelled += 1
        prefix = f"{session_id}:"
        for key, task in list(_session_tasks.items()):
            if not key.startswith(prefix):
                continue
            _session_tasks.pop(key, None)
            if task and not task.done():
                task.cancel()
                cancelled += 1
    return cancelled


async def schedule_hunter_thinking(
    session: dict[str, Any],
    *,
    candidates_count: int,
    emitted: list[dict[str, Any]],
    manual_tickers: list[str],
) -> None:
    """One hunter reasoning task per session; skip if recent or still running."""
    if _subagents_halted(session):
        return
    if not should_schedule_hunter_thinking(
        session,
        candidates_count=candidates_count,
        emitted=emitted,
        manual_tickers=manual_tickers,
    ):
        return
    session_id = session["id"]
    async with _task_lock:
        existing = _hunter_tasks.get(session_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(
            run_hunter_thinking(
                session,
                candidates_count=candidates_count,
                emitted=emitted,
                manual_tickers=manual_tickers,
            ),
            name=f"agentic-hunter-think-{session_id[:8]}",
        )
        _hunter_tasks[session_id] = task


async def schedule_session_thinking(
    session: dict[str, Any],
    suggestion: dict[str, Any],
    *,
    price: float,
    atr: float | None,
    allocation: float,
    headroom: float,
) -> None:
    """Background session reasoning; does not block order placement."""
    if _subagents_halted(session):
        return
    session_id = session["id"]
    key = f"{session_id}:{suggestion.get('ticker')}"
    async with _task_lock:
        existing = _session_tasks.get(key)
        if existing and not existing.done():
            return
        task = asyncio.create_task(
            run_session_thinking(
                session,
                suggestion,
                price=price,
                atr=atr,
                allocation=allocation,
                headroom=headroom,
            ),
            name=f"agentic-session-think-{key[:16]}",
        )
        _session_tasks[key] = task
