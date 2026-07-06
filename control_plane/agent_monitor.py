"""Background agent monitor: queue market context and flush to the chat agent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from control_plane.agent_thread_state import AGENT_PRODUCT, UI_PHASE_TRADING
from control_plane.news_service import NewsService, finnhub_ticker, get_news_service

log = logging.getLogger("backtrading")

MAX_QUEUE_ITEMS = int(os.getenv("AGENT_MONITOR_MAX_QUEUE", "100"))
MAX_QUEUE_AGE_SEC = int(os.getenv("AGENT_MONITOR_MAX_AGE_SEC", "600"))
POLL_INTERVAL_SEC = float(os.getenv("AGENT_MONITOR_POLL_SEC", "60"))
MARKET_INDEX_SYMBOLS = ("SPY", "QQQ")

MonitorBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


@dataclass
class AgentMonitorEvent:
    kind: str
    payload: dict[str, Any]
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "ts": self.ts, "payload": self.payload}


class AgentMonitorQueue:
    def __init__(self, *, max_items: int = MAX_QUEUE_ITEMS, max_age_sec: int = MAX_QUEUE_AGE_SEC) -> None:
        self.max_items = max_items
        self.max_age_sec = max_age_sec
        self.events: list[AgentMonitorEvent] = []
        self.started_at: float | None = None

    def enqueue(self, event: AgentMonitorEvent) -> bool:
        if not self.events:
            self.started_at = event.ts
        self.events.append(event)
        return self.should_flush()

    def should_flush(self) -> bool:
        if not self.events:
            return False
        if len(self.events) >= self.max_items:
            return True
        started = self.started_at or self.events[0].ts
        return (time.time() - started) >= self.max_age_sec

    def drain(self) -> list[AgentMonitorEvent]:
        rows = list(self.events)
        self.events.clear()
        self.started_at = None
        return rows

    @property
    def size(self) -> int:
        return len(self.events)


def _news_age_seconds(item: dict[str, Any]) -> float | None:
    for key in ("datetime", "published_at", "time", "ts"):
        raw = item.get(key)
        if raw is None:
            continue
        try:
            if isinstance(raw, (int, float)):
                value = float(raw)
                if value > 1_000_000_000_000:
                    value /= 1000.0
                return time.time() - value
            text = str(raw).strip()
            if text.isdigit():
                value = float(text)
                if value > 1_000_000_000_000:
                    value /= 1000.0
                return time.time() - value
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return time.time() - dt.timestamp()
        except (TypeError, ValueError):
            continue
    return None


async def _etoro_client(account_env: str):
    from brokers.etoro.trading_client import EtoroTradingClient

    env = "demo" if (account_env or "demo").lower() == "demo" else "live"
    client = EtoroTradingClient(account_env=env)
    client.generate_session()
    return client


async def collect_news_events(symbol: str, news: NewsService) -> list[AgentMonitorEvent]:
    ticker = finnhub_ticker(symbol)
    try:
        result = await news.company_news(ticker, notify=False)
        rows = result.get("data") if isinstance(result, dict) else []
    except Exception as exc:
        log.debug("[AGENT_MONITOR] news skip %s: %s", symbol, exc)
        return []

    fresh: list[AgentMonitorEvent] = []
    for row in rows[:12]:
        if not isinstance(row, dict):
            continue
        age = _news_age_seconds(row)
        if age is not None and age > MAX_QUEUE_AGE_SEC:
            continue
        fresh.append(AgentMonitorEvent(
            kind="news",
            payload={
                "headline": row.get("headline") or row.get("title") or "",
                "url": row.get("url") or row.get("link") or "",
                "source": row.get("source") or "",
            },
        ))
    return fresh


async def collect_earnings_events(symbol: str, news: NewsService) -> list[AgentMonitorEvent]:
    ticker = finnhub_ticker(symbol)
    try:
        result = await news.earnings_calendar(ticker)
        rows = result.get("data") if isinstance(result, dict) else []
    except Exception as exc:
        log.debug("[AGENT_MONITOR] earnings skip %s: %s", symbol, exc)
        return []

    fresh: list[AgentMonitorEvent] = []
    for row in rows[:6]:
        if not isinstance(row, dict):
            continue
        fresh.append(AgentMonitorEvent(
            kind="earnings",
            payload={
                "symbol": row.get("symbol") or ticker,
                "date": row.get("date") or row.get("period") or "",
                "hour": row.get("hour") or "",
                "eps_estimate": row.get("epsEstimate"),
                "revenue_estimate": row.get("revenueEstimate"),
            },
        ))
    return fresh


async def collect_market_context_events(news: NewsService) -> list[AgentMonitorEvent]:
    events: list[AgentMonitorEvent] = []
    try:
        result = await news.market_news("general")
        headlines = result.get("data") if isinstance(result, dict) else []
        events.append(AgentMonitorEvent(
            kind="market_context",
            payload={
                "headlines": [
                    {
                        "title": row.get("headline") or row.get("title") or "",
                        "url": row.get("url") or "",
                    }
                    for row in headlines[:8]
                    if isinstance(row, dict)
                ],
                "indices": list(MARKET_INDEX_SYMBOLS),
            },
        ))
    except Exception as exc:
        log.debug("[AGENT_MONITOR] market context skip: %s", exc)
    return events


async def collect_stock_stats_events(
    *,
    symbol: str,
    token: str | None,
    broker: str,
    account_env: str,
) -> list[AgentMonitorEvent]:
    if broker.lower() != "etoro":
        return []

    from brokers.etoro.candles import CANDLE_INTERVAL_ONE_MINUTE, aget_historical_candles

    try:
        client = await _etoro_client(account_env)
        instrument_id = await client._instrument_id(symbol, str(token or symbol))
        if instrument_id is None:
            return []
        candles = await aget_historical_candles(
            client,
            instrument_id,
            interval=CANDLE_INTERVAL_ONE_MINUTE,
            count=10,
            direction="desc",
        )
    except Exception as exc:
        log.debug("[AGENT_MONITOR] stock stats skip %s: %s", symbol, exc)
        return []

    if not candles:
        return []

    ordered = sorted(candles, key=lambda row: int(row.get("time") or 0))
    closes = [float(row.get("close") or 0) for row in ordered if row.get("close")]
    highs = [float(row.get("high") or 0) for row in ordered if row.get("high")]
    lows = [float(row.get("low") or 0) for row in ordered if row.get("low")]
    if not closes:
        return []

    first = closes[0]
    last = closes[-1]
    move_pct = ((last - first) / first * 100) if first else 0.0
    return [AgentMonitorEvent(
        kind="stock_stats",
        payload={
            "symbol": symbol,
            "bars": len(ordered),
            "window_minutes": min(10, len(ordered)),
            "open": first,
            "last": last,
            "high": max(highs) if highs else last,
            "low": min(lows) if lows else last,
            "move_pct": round(move_pct, 3),
            "candles": ordered[-10:],
        },
    )]


async def collect_portfolio_events(
    *,
    focus: dict[str, Any],
    session: dict[str, Any],
) -> list[AgentMonitorEvent]:
    broker = str(focus.get("broker") or "etoro").lower()
    account_env = str(focus.get("account_env") or "demo")
    symbol = str(focus.get("symbol") or "")
    execution_id = str(focus.get("execution_id") or "")

    payload: dict[str, Any] = {
        "symbol": symbol,
        "execution_id": execution_id or None,
        "close_price": focus.get("close_price"),
        "long_percent": focus.get("long_percent"),
        "short_percent": focus.get("short_percent"),
        "capital": focus.get("max_available_capital"),
        "actions": [],
    }

    for action in session.get("actions") or []:
        if not isinstance(action, dict):
            continue
        action_payload = action.get("payload") or {}
        if symbol and str(action_payload.get("symbol") or "").split("-")[0].upper() != symbol.split("-")[0].upper():
            continue
        payload["actions"].append({
            "title": action.get("title"),
            "status": action.get("status"),
            "type": action.get("type"),
        })

    if broker == "etoro":
        try:
            client = await _etoro_client(account_env)
            portfolio = await client.aget_client_portfolio()
            positions = portfolio.get("positions") or []
            matched = []
            sym_root = symbol.split("-")[0].upper()
            for row in positions:
                if not isinstance(row, dict):
                    continue
                inst = str(row.get("instrumentDisplayName") or row.get("symbol") or "")
                if sym_root and sym_root not in inst.upper():
                    continue
                pnl = row.get("unrealizedPnL")
                if isinstance(pnl, dict):
                    pnl = pnl.get("pnL")
                matched.append({
                    "units": row.get("units") or row.get("amount"),
                    "open_rate": row.get("openRate"),
                    "pnl": pnl,
                })
            payload["open_positions"] = matched
        except Exception as exc:
            log.debug("[AGENT_MONITOR] portfolio skip: %s", exc)
            payload["portfolio_error"] = str(exc)

    return [AgentMonitorEvent(kind="portfolio", payload=payload)]


def summarize_monitor_batch_events(events: list[AgentMonitorEvent]) -> list[dict[str, Any]]:
    """Human-readable breakdown of queued monitor payloads for the UI accordion."""
    grouped: dict[str, list[AgentMonitorEvent]] = {}
    for event in events:
        grouped.setdefault(event.kind, []).append(event)

    items: list[dict[str, Any]] = []

    news_rows = grouped.get("news") or []
    if news_rows:
        samples = [
            str(row.payload.get("headline") or row.payload.get("title") or "").strip()[:100]
            for row in news_rows[:3]
            if str(row.payload.get("headline") or row.payload.get("title") or "").strip()
        ]
        items.append({
            "kind": "news",
            "label": "News items",
            "count": len(news_rows),
            "samples": samples,
        })

    earnings_rows = grouped.get("earnings") or []
    if earnings_rows:
        samples = [
            f"{row.payload.get('date') or '—'}"
            + (f" ({row.payload.get('hour')})" if row.payload.get("hour") else "")
            for row in earnings_rows[:3]
        ]
        items.append({
            "kind": "earnings",
            "label": "Earnings calendar",
            "count": len(earnings_rows),
            "samples": samples,
        })

    market_rows = grouped.get("market_context") or []
    if market_rows:
        headlines: list[str] = []
        for row in market_rows:
            for headline in row.payload.get("headlines") or []:
                if not isinstance(headline, dict):
                    continue
                title = str(headline.get("title") or headline.get("headline") or "").strip()[:100]
                if title:
                    headlines.append(title)
        indices = []
        if market_rows:
            raw_indices = market_rows[-1].payload.get("indices") or []
            indices = [str(value) for value in raw_indices if value]
        detail = f"Indices: {', '.join(indices)}" if indices else None
        items.append({
            "kind": "market_context",
            "label": "Market headlines",
            "count": len(headlines),
            "detail": detail,
            "samples": headlines[:3],
        })

    stats_rows = grouped.get("stock_stats") or []
    if stats_rows:
        latest = stats_rows[-1].payload
        window = int(latest.get("window_minutes") or latest.get("bars") or 10)
        move = latest.get("move_pct")
        detail = f"{window}m window"
        if move is not None:
            detail += f" · {float(move):+.2f}% move"
        items.append({
            "kind": "stock_stats",
            "label": "Price candles",
            "count": len(stats_rows),
            "detail": detail,
        })

    portfolio_rows = grouped.get("portfolio") or []
    if portfolio_rows:
        latest = portfolio_rows[-1].payload
        open_positions = len(latest.get("open_positions") or [])
        actions = len(latest.get("actions") or [])
        if open_positions:
            detail = f"{open_positions} open position(s)"
        elif actions:
            detail = f"{actions} strategy action(s)"
        else:
            detail = "No open positions"
        items.append({
            "kind": "portfolio",
            "label": "Portfolio snapshot",
            "count": len(portfolio_rows),
            "detail": detail,
        })

    return items


def summarize_client_monitor_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Build monitor-batch accordion rows from a client-consolidated snapshot."""
    items: list[dict[str, Any]] = []
    window = int(context.get("window_minutes") or 10)

    news = context.get("news") or []
    if isinstance(news, list) and news:
        samples = [
            str(row.get("headline") or row.get("title") or "").strip()[:100]
            for row in news[:3]
            if isinstance(row, dict) and str(row.get("headline") or row.get("title") or "").strip()
        ]
        items.append({
            "kind": "news",
            "label": "News items",
            "count": len(news),
            "samples": samples,
        })

    market = context.get("market_headlines") or []
    if isinstance(market, list) and market:
        samples = [
            str(row.get("title") or row.get("headline") or "").strip()[:100]
            for row in market[:3]
            if isinstance(row, dict) and str(row.get("title") or row.get("headline") or "").strip()
        ]
        indices = context.get("indices") or []
        index_labels = [
            str(row.get("label") or row.get("id") or "")
            for row in indices
            if isinstance(row, dict) and row.get("label")
        ]
        detail = f"Indices: {', '.join(index_labels)}" if index_labels else None
        items.append({
            "kind": "market_context",
            "label": "Market headlines",
            "count": len(market),
            "detail": detail,
            "samples": samples,
        })

    indices = context.get("indices") or []
    if isinstance(indices, list) and indices:
        parts = []
        for row in indices[:3]:
            if not isinstance(row, dict):
                continue
            label = str(row.get("label") or row.get("id") or "")
            ltp = row.get("ltp")
            change = row.get("change_10m")
            text = label
            if ltp is not None:
                text += f" {ltp}"
            if change is not None:
                text += f" ({float(change):+.2f}%)"
            if text.strip():
                parts.append(text.strip())
        items.append({
            "kind": "indices",
            "label": "Index levels",
            "count": len(indices),
            "detail": " · ".join(parts) if parts else None,
        })

    price = context.get("price") if isinstance(context.get("price"), dict) else {}
    samples = price.get("samples") or []
    if price or samples:
        move = price.get("move_pct")
        high = price.get("high")
        low = price.get("low")
        detail = f"{window}m window"
        if move is not None:
            detail += f" · {float(move):+.2f}% move"
        if high is not None and low is not None:
            detail += f" · H {high} / L {low}"
        items.append({
            "kind": "stock_stats",
            "label": "Price candles",
            "count": len(samples) if isinstance(samples, list) else 1,
            "detail": detail,
        })

    positions = context.get("positions") or []
    if isinstance(positions, list):
        open_count = sum(
            1 for row in positions
            if isinstance(row, dict) and str(row.get("state") or "open").lower() in {"open", "active", "running"}
        )
        detail = f"{open_count} open position(s)" if open_count else "No open positions"
        items.append({
            "kind": "portfolio",
            "label": "Portfolio snapshot",
            "count": len(positions),
            "detail": detail,
        })

    return items


def build_client_monitor_prompt(
    focus: dict[str, Any],
    context: dict[str, Any],
    *,
    instructions: str | None = None,
) -> str:
    symbol = focus.get("symbol") or context.get("symbol") or "the focused symbol"
    candidates = context.get("candidates") or []
    if isinstance(candidates, list) and len(candidates) > 1:
        names = ", ".join(
            str(row.get("symbol") or "").split("-")[0]
            for row in candidates
            if isinstance(row, dict) and row.get("symbol")
        )
        symbol_label = names or symbol
    else:
        symbol_label = symbol
    window = int(context.get("window_minutes") or 10)
    focus_json = json.dumps(focus, ensure_ascii=False, indent=2)
    context_json = json.dumps(context, ensure_ascii=False, indent=2)
    base = (
        f"[Monitor batch] Client-side {window}m market snapshot for {symbol_label}.\n\n"
        f"Trade focus:\n```json\n{focus_json}\n```\n\n"
        f"Consolidated live context (prices, news, indices, positions):\n```json\n{context_json}\n```\n\n"
    )
    if instructions:
        return base + instructions.strip() + "\n"
    return (
        base
        + "Respond with A2UI only (TradeDecision, InsightCards, CandidateDebate, or ButtonRow). "
        "If the thesis is intact, say so briefly in TradeDecision. "
        "If target/stop/position size should change, recommend it. No markdown."
    )


CLIENT_MONITOR_WEB_NEWS_INSTRUCTIONS = (
    "Use web search ONLY for fresh news and catalysts on the focused symbol and its sector. "
    "Do NOT read the local repo, codebase, or control-plane files. "
    "Do NOT use grep, read_file, or codebase_search. "
    "Summarize what you find on the web in A2UI only: TradeDecision for the headline call, "
    "InsightCards for highlights/lowlights/cautions. Include a short Sources section in InsightCards cautions. "
    "No markdown prose."
)

CLIENT_MONITOR_AUTONOMOUS_PLAN_INSTRUCTIONS = (
    "You are the trading monitor (Plan mode). Treat each client monitor batch as ground truth "
    "for live prices (`candidates[]`, `price` samples), indices, positions, `etoro_account`, and headlines.\n"
    "DEEP ANALYSIS (required every batch):\n"
    "1) CandidateDebate — 6–10 sentences: compare EVERY symbol in `candidates[]` using price samples, "
    "high/low, index drift, open positions, eToro portfolio, and headlines. Rank setups by risk/reward.\n"
    "2) Websearch + Finnhub MCP for catalysts, earnings, sector news — cite sources in InsightCards cautions.\n"
    "3) TradeDecision — one-line action + REQUIRED `confidence_pct` (0–100) for your top setup.\n"
    "4) InsightCards — highlights/lowlights/cautions grounded in batch + research.\n"
    "STRATEGY RULES:\n"
    "- If confidence_pct >= 50 on the best setup: emit StrategySetupForm (pre-filled from live LTP) "
    "and StrategySummary props — do NOT emit TopStockPicks or chart components.\n"
    "- If confidence_pct < 50: HOLD — explain in TradeDecision; no setup form.\n"
    "AUTONOMOUS ACTIONS (emit fenced JSON ai_action when warranted):\n"
    "- exit_strategy / close_position when thesis breaks or target/stop hit (include execution_id, reason).\n"
    "- update_order_prices when target/stop/entry should change (execution_id, close_price, long_percent, short_percent, reason).\n"
    "- Use websearch before exit or price updates when news may be the catalyst.\n"
    "Use ButtonRow only for user choices (enter / wait). Do NOT place orders in Plan mode. No markdown prose."
)

def _execute_monitor_instructions() -> str:
    from control_plane.agent_autonomous_trade import autonomous_min_confidence

    threshold = int(autonomous_min_confidence())
    return (
        "You are the AUTONOMOUS trading monitor (Trade / execute mode). The user delegated decisions to you — "
        "do NOT ask permission via ButtonRow. ACT when edge is clear.\n\n"
        "DEEP ANALYSIS (required every batch):\n"
        "1) CandidateDebate — 6–10 sentences: compare EVERY symbol in `candidates[]` using live samples, "
        "index drift, `etoro_account` positions/orders, and headlines. Rank setups; name the single best risk/reward.\n"
        "2) Websearch + Finnhub MCP for catalysts, earnings, sector news — fold into debate + InsightCards (cite sources).\n"
        "3) TradeDecision — one line action + REQUIRED `confidence_pct` (0–100) for your primary call.\n"
        "4) InsightCards — highlights/lowlights/cautions.\n\n"
        "ENTRY RULES (no open position on symbol):\n"
        f"- If best setup confidence_pct >= {threshold}: emit fenced JSON ai_action "
        "autonomous_entry (NOT ButtonRow, NOT TopStockPicks). Include full deploy payload:\n"
        "  symbol, token, exchange, broker, account_env, close_price (live LTP), long_percent, short_percent, "
        "max_available_capital, confidence_pct, rationale.\n"
        f"- After entry intent, also emit StrategySummary A2UI with symbol, entry_price, execution_id placeholder "
        "(server links execution automatically). Do NOT emit TopStockPicks or chart components.\n"
        f"- If confidence_pct < {threshold}: HOLD — TradeDecision explains why; "
        "do NOT emit autonomous_entry or ButtonRow.\n"
        "- Pick at most ONE symbol per batch (highest conviction).\n"
        "- Use thread broker/account_env from focus/metadata; always use `etoro_account` for sizing.\n\n"
        "POSITION MANAGEMENT (open position):\n"
        "- Thesis breaks, stop deteriorating, or target met → ai_action exit_strategy "
        "(execution_id, symbol, reason) → trade_complete when flat.\n"
        "- Target/stop/entry should change → ai_action update_order_prices "
        "(execution_id, close_price, long_percent, short_percent, reason).\n"
        "- Before exit or price update, websearch for breaking news on the symbol.\n\n"
        "NEVER emit ButtonRow, StrategySetupForm, or TopStockPicks in execute-mode monitor. No markdown prose."
    )


def monitor_instructions_for_mode(interaction_mode: str) -> str:
    mode = str(interaction_mode or "ask").strip().lower()
    if mode == "execute":
        return _execute_monitor_instructions()
    return CLIENT_MONITOR_AUTONOMOUS_PLAN_INSTRUCTIONS


# Back-compat alias
CLIENT_MONITOR_AUTONOMOUS_INSTRUCTIONS = "execute"  # resolved via monitor_instructions_for_mode


def build_monitor_flush_prompt(focus: dict[str, Any], events: list[AgentMonitorEvent]) -> str:
    sections = []
    for event in events:
        sections.append(f"## {event.kind}\n```json\n{json.dumps(event.payload, ensure_ascii=False)}\n```")

    focus_json = json.dumps(focus, ensure_ascii=False, indent=2)
    symbol = focus.get("symbol") or "the focused symbol"
    return (
        f"[Monitor batch] Review {len(events)} queued updates for {symbol}.\n\n"
        f"Trade focus:\n```json\n{focus_json}\n```\n\n"
        f"Queued updates:\n\n"
        + "\n\n".join(sections)
        + "\n\n"
        "Respond with A2UI only (TradeDecision, InsightCards, CandidateDebate, or ButtonRow). "
        "If the thesis is intact, say so briefly in TradeDecision. "
        "If target/stop/position size should change, recommend it. No markdown."
    )


@dataclass
class _ThreadMonitor:
    thread_id: str
    queue: AgentMonitorQueue
    focus_key: str
    flushing: bool = False
    last_poll_at: float = 0.0
    last_flush_at: float = 0.0


class AgentMonitorService:
    def __init__(self, *, broadcast: MonitorBroadcast | None = None) -> None:
        self.broadcast = broadcast
        self._threads: dict[str, _ThreadMonitor] = {}
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._flush_locks: dict[str, asyncio.Lock] = {}

    @property
    def enabled(self) -> bool:
        return _env_bool("AGENT_MONITOR_ENABLED", False)

    async def start(self) -> None:
        if not self.enabled:
            log.info("[AGENT_MONITOR] disabled by AGENT_MONITOR_ENABLED")
            return
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="agent-monitor")
        log.info("[AGENT_MONITOR] service started poll=%ss queue=%s age=%ss",
                 POLL_INTERVAL_SEC, MAX_QUEUE_ITEMS, MAX_QUEUE_AGE_SEC)

    async def stop(self) -> None:
        self._stopped.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._threads.clear()

    def status(self, thread_id: str) -> dict[str, Any]:
        from api.ai_research_routes import get_ai_research_store

        session = get_ai_research_store().get_session(thread_id) or {}
        metadata = session.get("metadata") or {}
        row = self._threads.get(thread_id)
        return self._build_status(thread_id, row, metadata)

    def _build_status(
        self,
        thread_id: str,
        row: _ThreadMonitor | None,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        completed = metadata.get("monitor_state") == "completed"
        client_mode = bool(metadata.get("monitor_client_mode")) or not self.enabled
        base = {
            "thread_id": thread_id,
            "queue_max_items": MAX_QUEUE_ITEMS,
            "queue_max_age_sec": MAX_QUEUE_AGE_SEC,
            "poll_interval_sec": POLL_INTERVAL_SEC,
            "completed": completed,
            "client_mode": client_mode,
            "monitor_state": metadata.get("monitor_state") or ("active" if row else "idle"),
        }
        if not row or completed:
            return {
                **base,
                "active": False,
                "queue_size": 0,
                "flushing": False,
                "job_state": "stopped",
                "queue_started_at": None,
                "flush_at": None,
                "next_poll_at": None,
            }
        queue = row.queue
        now = time.time()
        started_at = queue.started_at if queue.size else None
        flush_at = (started_at + queue.max_age_sec) if started_at else None
        next_poll_at = (row.last_poll_at + POLL_INTERVAL_SEC) if row.last_poll_at else None
        if row.flushing:
            job_state = "waiting_agent"
        else:
            job_state = "running"
        return {
            **base,
            "active": True,
            "queue_size": queue.size,
            "flushing": row.flushing,
            "job_state": job_state,
            "focus_key": row.focus_key,
            "last_poll_at": row.last_poll_at or None,
            "last_flush_at": row.last_flush_at or None,
            "queue_started_at": started_at,
            "flush_at": flush_at,
            "next_poll_at": next_poll_at,
            "now": now,
        }

    async def _broadcast_status(self, thread_id: str) -> None:
        if not self.broadcast:
            return
        payload = {"type": "monitor_status", **self.status(thread_id)}
        await self.broadcast(thread_id, payload)

    async def start_thread(self, thread_id: str) -> dict[str, Any]:
        from api.ai_research_routes import get_ai_research_store
        from control_plane.agent_thread_state import resolve_agent_focus
        from control_plane.engine_registry import EngineRegistry

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if not session:
            raise ValueError("thread not found")
        metadata = session.get("metadata") or {}
        if metadata.get("product") != AGENT_PRODUCT:
            raise ValueError("not an agent thread")
        if metadata.get("monitor_state") == "completed":
            return self.status(thread_id)

        focus = resolve_agent_focus(session, EngineRegistry())
        symbol = str(focus.get("symbol") or "").strip()
        if not symbol:
            raise ValueError("thread has no focus symbol")

        metadata = {
            **metadata,
            "focus": focus,
            "monitor_active": True,
            "monitor_state": "active",
            "monitor_started_at": time.time(),
        }
        metadata.pop("monitor_completed_at", None)
        metadata.pop("monitor_complete_reason", None)
        store.update_session(thread_id, {"metadata": metadata})
        session = store.get_session(thread_id) or session

        focus_key = self._focus_key(focus)
        existing = self._threads.get(thread_id)
        if existing and existing.focus_key == focus_key:
            return self.status(thread_id)

        if existing:
            await self._flush_thread(thread_id, existing, force=True)

        self._threads[thread_id] = _ThreadMonitor(
            thread_id=thread_id,
            queue=AgentMonitorQueue(),
            focus_key=focus_key,
        )
        log.info("[AGENT_MONITOR] started thread=%s symbol=%s", thread_id, symbol)
        status = self.status(thread_id)
        await self._broadcast_status(thread_id)
        return status

    async def stop_thread(self, thread_id: str) -> dict[str, Any]:
        from api.ai_research_routes import get_ai_research_store

        row = self._threads.pop(thread_id, None)
        if row and row.queue.size:
            await self._flush_thread(thread_id, row, force=True)

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if session:
            metadata = dict(session.get("metadata") or {})
            metadata["monitor_active"] = False
            store.update_session(thread_id, {"metadata": metadata})
        status = self.status(thread_id)
        await self._broadcast_status(thread_id)
        return status

    async def complete_thread(self, thread_id: str, *, reason: str = "trade_complete") -> dict[str, Any]:
        from control_plane.agent_trade_completion import mark_monitor_completed

        await self.stop_thread(thread_id)
        mark_monitor_completed(thread_id, reason=reason)
        log.info("[AGENT_MONITOR] completed thread=%s reason=%s", thread_id, reason)
        return self.status(thread_id)

    @staticmethod
    def _focus_key(focus: dict[str, Any]) -> str:
        return "|".join([
            str(focus.get("symbol") or ""),
            str(focus.get("broker") or ""),
            str(focus.get("account_env") or ""),
            str(focus.get("token") or ""),
        ])

    async def _run(self) -> None:
        try:
            while not self._stopped.is_set():
                await self._poll_all()
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=POLL_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise

    async def _poll_all(self) -> None:
        for thread_id, row in list(self._threads.items()):
            try:
                await self._poll_thread(thread_id, row)
            except Exception as exc:
                log.warning("[AGENT_MONITOR] poll failed thread=%s: %s", thread_id, exc)

    async def _poll_thread(self, thread_id: str, row: _ThreadMonitor) -> None:
        from api.ai_research_routes import get_ai_research_store
        from control_plane.agent_thread_state import resolve_agent_focus
        from control_plane.engine_registry import EngineRegistry

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if not session:
            self._threads.pop(thread_id, None)
            return

        metadata = session.get("metadata") or {}
        if metadata.get("monitor_state") == "completed":
            self._threads.pop(thread_id, None)
            return

        focus = resolve_agent_focus(session, EngineRegistry())
        symbol = str(focus.get("symbol") or "").strip()
        if not symbol or metadata.get("ui_phase") != UI_PHASE_TRADING:
            return

        resolved_key = self._focus_key(focus)
        if row.focus_key != resolved_key:
            row.focus_key = resolved_key
            row.queue = AgentMonitorQueue()

        news = get_news_service()
        broker = str(focus.get("broker") or "etoro")
        account_env = str(focus.get("account_env") or "demo")
        token = focus.get("token")

        collectors = await asyncio.gather(
            collect_news_events(symbol, news),
            collect_earnings_events(symbol, news),
            collect_market_context_events(news),
            collect_stock_stats_events(
                symbol=symbol,
                token=str(token) if token else None,
                broker=broker,
                account_env=account_env,
            ),
            collect_portfolio_events(focus=focus, session=session),
            return_exceptions=True,
        )

        added = 0
        for batch in collectors:
            if isinstance(batch, Exception):
                continue
            for event in batch:
                if row.queue.enqueue(event):
                    added += 1
                    await self._flush_thread(thread_id, row)
                    return
                added += 1

        row.last_poll_at = time.time()
        await self._broadcast_status(thread_id)
        if row.queue.should_flush():
            await self._flush_thread(thread_id, row)

    async def _flush_thread(
        self,
        thread_id: str,
        row: _ThreadMonitor,
        *,
        force: bool = False,
    ) -> None:
        if row.flushing:
            return
        if not force and not row.queue.should_flush():
            return

        lock = self._flush_locks.setdefault(thread_id, asyncio.Lock())
        async with lock:
            if row.flushing:
                return
            events = row.queue.drain()
            if not events:
                return
            row.flushing = True
            await self._broadcast_status(thread_id)
            try:
                await self._run_agent_flush(thread_id, events)
                row.last_flush_at = time.time()
            finally:
                row.flushing = False
                await self._broadcast_status(thread_id)

    async def _run_agent_flush(self, thread_id: str, events: list[AgentMonitorEvent]) -> None:
        from api.ai_research_routes import get_ai_research_store
        from control_plane.agent_thread_state import resolve_agent_focus
        from control_plane.engine_registry import EngineRegistry

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if not session:
            return

        registry = EngineRegistry()
        focus = resolve_agent_focus(session, registry)
        prompt = build_monitor_flush_prompt(focus, events)
        prompt += (
            "\n\nIf all positions are closed (profit or loss), emit trade_complete ai_action "
            "with pnl fields — automated monitoring will stop until the user sends a new message."
        )
        kinds = [event.kind for event in events]
        batch_items = summarize_monitor_batch_events(events)
        await self._execute_context_flush(
            thread_id,
            focus,
            prompt,
            batch_items,
            len(events),
            kinds,
        )

    async def flush_client_context(
        self,
        thread_id: str,
        context: dict[str, Any],
        *,
        instructions: str | None = None,
    ) -> dict[str, Any]:
        from api.ai_research_routes import get_ai_research_store
        from control_plane.agent_thread_state import resolve_agent_focus
        from control_plane.engine_registry import EngineRegistry

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if not session:
            raise ValueError("thread not found")

        metadata = session.get("metadata") or {}
        if metadata.get("product") != AGENT_PRODUCT:
            raise ValueError("not an agent thread")
        if metadata.get("monitor_state") == "completed":
            return {**self._build_status(thread_id, None, metadata), "client_mode": True}

        registry = EngineRegistry()
        focus = resolve_agent_focus(session, registry)
        symbol = str(focus.get("symbol") or context.get("symbol") or "").strip()
        if not symbol:
            candidates = context.get("candidates") if isinstance(context.get("candidates"), list) else []
            for row in candidates:
                if isinstance(row, dict) and row.get("symbol"):
                    symbol = str(row["symbol"]).strip()
                    break
        if not symbol:
            raise ValueError("thread has no focus symbol")

        metadata = {
            **metadata,
            "focus": focus,
            "monitor_active": True,
            "monitor_state": "active",
            "monitor_client_mode": True,
            "monitor_started_at": metadata.get("monitor_started_at") or time.time(),
        }
        metadata.pop("monitor_completed_at", None)
        metadata.pop("monitor_complete_reason", None)
        store.update_session(thread_id, {"metadata": metadata})
        session = store.get_session(thread_id) or session
        metadata = session.get("metadata") or metadata

        batch_items = summarize_client_monitor_context(context)
        kinds = [str(item.get("kind") or "context") for item in batch_items]
        event_count = sum(int(item.get("count") or 0) for item in batch_items) or len(batch_items)
        prompt = build_client_monitor_prompt(focus, context, instructions=instructions)
        prompt += (
            "\n\nIf all positions are closed (profit or loss), emit trade_complete ai_action "
            "with pnl fields — automated monitoring will stop until the user sends a new message."
        )

        focus_key = self._focus_key(focus)
        row = self._threads.get(thread_id)
        if not row:
            row = _ThreadMonitor(thread_id=thread_id, queue=AgentMonitorQueue(), focus_key=focus_key)
            self._threads[thread_id] = row
        elif row.focus_key != focus_key:
            row.focus_key = focus_key
            row.queue = AgentMonitorQueue()

        if row.flushing:
            return {**self._build_status(thread_id, row, metadata), "client_mode": True}

        row.flushing = True
        await self._broadcast_status(thread_id)
        asyncio.create_task(
            self._execute_context_flush(
                thread_id,
                focus,
                prompt,
                batch_items,
                event_count,
                kinds,
                row=row,
            ),
            name=f"agent-monitor-client-flush-{thread_id[:8]}",
        )
        return {**self._build_status(thread_id, row, metadata), "client_mode": True}

    async def _execute_context_flush(
        self,
        thread_id: str,
        focus: dict[str, Any],
        prompt: str,
        batch_items: list[dict[str, Any]],
        event_count: int,
        kinds: list[str],
        *,
        row: _ThreadMonitor | None = None,
    ) -> None:
        from api.ai_research_routes import get_ai_research_store
        from api.a2ui_bridge import monitor_batch_surface
        from api.cursor_agent import cursor_agent_service, load_cursor_api_env
        from api.cursor_to_agui import cursor_event_to_agui, run_error, run_finished, run_started, thread_updated
        from control_plane.agent_thread_state import sync_focus_from_actions, sync_focus_from_registry
        from control_plane.engine_registry import EngineRegistry

        load_cursor_api_env()
        if not cursor_agent_service.configured:
            log.warning("[AGENT_MONITOR] cursor agent not configured — skip flush")
            if row:
                row.flushing = False
                await self._broadcast_status(thread_id)
            return

        store = get_ai_research_store()
        session = store.get_session(thread_id)
        if not session:
            if row:
                row.flushing = False
                await self._broadcast_status(thread_id)
            return

        symbol = str(focus.get("symbol") or "").strip()
        run_id = str(uuid.uuid4())
        text_buffer: list[str] = []
        batch_message_id = f"monitor-{run_id}"

        async def _emit(payload: dict[str, Any]) -> None:
            if self.broadcast:
                await self.broadcast(thread_id, payload)

        await _emit(run_started(thread_id, run_id))
        await _emit(monitor_batch_surface(
            run_id=run_id,
            symbol=symbol,
            event_count=event_count,
            kinds=kinds,
            items=batch_items,
        ))
        store.append_message(
            thread_id,
            role="assistant",
            content=f"[monitor_batch] {symbol} · {event_count} updates",
            run_id=run_id,
            message_id=batch_message_id,
            metadata={
                "source": "agent_monitor",
                "monitor_batch": {
                    "symbol": symbol,
                    "eventCount": event_count,
                    "items": batch_items,
                },
            },
        )

        agent_id = session.get("cursor_agent_id")
        metadata = session.get("metadata") or {}
        web_search = bool(metadata.get("web_search_enabled", True))
        interaction_mode = str(session.get("interaction_mode") or "execute")
        try:
            async for event in cursor_agent_service.stream_chat(
                prompt=prompt,
                agent_id=agent_id,
                interaction_mode=interaction_mode,
                web_search_enabled=web_search,
                research_session_id=thread_id,
                message_source="agent_monitor",
            ):
                for agui_event in cursor_event_to_agui(
                    event,
                    thread_id=thread_id,
                    run_id=run_id,
                    text_buffer=text_buffer,
                ):
                    await _emit(agui_event)

                if event.get("type") == "done":
                    full_text = str(event.get("text") or "")
                    if not full_text and text_buffer:
                        full_text = "".join(text_buffer)
                    from control_plane.agent_trade_completion import process_assistant_monitor_actions

                    await process_assistant_monitor_actions(thread_id, full_text)
                    registry = EngineRegistry()
                    store.sync_session_action_links(thread_id, registry)
                    from api.ai_research_routes import enrich_session_metadata

                    enrich_session_metadata(store, thread_id)
                    session_row = store.get_session(thread_id)
                    if session_row:
                        session_row = sync_focus_from_registry(session_row, registry)
                        session_row = sync_focus_from_actions(session_row)
                        await _emit(thread_updated(thread_id, session_row))
                    break
                if event.get("type") in {"error", "stopped"}:
                    break
        except Exception as exc:
            log.exception("[AGENT_MONITOR] flush failed thread=%s", thread_id)
            await _emit(run_error(str(exc), thread_id, run_id))
        finally:
            if row:
                row.flushing = False
                row.last_flush_at = time.time()
                await self._broadcast_status(thread_id)

        await _emit(run_finished(thread_id, run_id))


_service: AgentMonitorService | None = None


def get_agent_monitor_service() -> AgentMonitorService:
    global _service
    if _service is None:
        from api.agent_monitor_feed import get_agent_monitor_feed_hub

        hub = get_agent_monitor_feed_hub()
        _service = AgentMonitorService(broadcast=hub.broadcast)
    return _service
