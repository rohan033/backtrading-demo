"""AI agent selection + research briefs for 1% trading sessions."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from api.a2ui_bridge import extract_a2ui_blocks
from control_plane.one_percent_candidates import detect_market_phase, resolve_etoro_candidate

log = logging.getLogger("backtrading")

_PLACE_CONFIDENCE_FLOOR = 55.0


class OnePercentAgentStoreAdapter:
    """Adapts OnePercentSessionStore to the trading-session agent event API."""

    def __init__(self, store: Any, *, state: str = "selecting"):
        self._store = store
        self._state = state

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        return self._store.get_session(session_id)

    def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        return self._store.append_event(
            session_id,
            event_type,
            state=self._state,
            payload=payload if isinstance(payload, dict) else {},
        )

    def list_events(
        self,
        session_id: str,
        *,
        since_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        return self._store.list_events(session_id, since_id=since_id, limit=limit)


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _headline(item: dict[str, Any]) -> str:
    return str(item.get("headline") or item.get("summary") or item.get("title") or "").strip()


async def resolve_focus_symbol_candidates(
    symbols: list[str],
    *,
    account_env: str = "demo",
    exclude_symbols: set[str] | None = None,
) -> dict[str, Any]:
    """Resolve user-supplied tickers to eToro instruments (no screener)."""
    exclude = {str(s or "").upper() for s in (exclude_symbols or set()) if s}
    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    for raw in symbols:
        base = str(raw or "").strip().upper().split(".", 1)[0]
        if not base:
            continue
        if base in exclude or any(str(c.get("symbol") or "").upper().startswith(base) for c in resolved):
            continue
        hit = await resolve_etoro_candidate({"symbol": base, "name": base}, account_env=account_env)
        if not hit:
            unresolved.append({"symbol": base, "reason": "not_found_on_etoro"})
            continue
        resolved.append({
            **hit,
            "score": hit.get("score") if hit.get("score") is not None else 0.0,
            "change_pct": hit.get("change_pct"),
            "focus_symbol": True,
        })
    return {
        "market_phase": detect_market_phase(),
        "screener_mode": "focus",
        "query_key": "focus_symbols",
        "query_keys": [],
        "screener_ids": [],
        "query_name": "Specific stocks",
        "query_names": ["Specific stocks"],
        "min_score": 0.0,
        "sources": [{"type": "focus_symbols", "symbols": symbols}],
        "total_found": len(resolved) + len(unresolved),
        "candidates": resolved,
        "unresolved": unresolved,
    }


async def _research_one(symbol: str, candidate: dict[str, Any]) -> dict[str, Any]:
    """Gather Finnhub + screener context for one symbol (best-effort)."""
    ticker = str(symbol or "").split(".", 1)[0].upper()
    brief: dict[str, Any] = {
        "symbol": ticker,
        "etoro_symbol": candidate.get("symbol") or ticker,
        "name": candidate.get("instrument_name") or candidate.get("name") or ticker,
        "price": candidate.get("close") or candidate.get("etoro_ltp"),
        "score": candidate.get("score"),
        "change_pct": candidate.get("change_pct"),
        "market_phase": detect_market_phase(),
        "news": [],
        "recommendation": None,
        "market_mood": [],
        "errors": [],
    }
    try:
        from control_plane.news_service import get_news_service

        news_svc = get_news_service()
    except Exception as exc:
        brief["errors"].append(f"news_service: {exc}")
        return brief

    try:
        company = await news_svc.company_news(ticker, days=5)
        items = _safe_list(company.get("data") if isinstance(company, dict) else None)
        brief["news"] = [
            {
                "headline": _headline(item)[:160],
                "source": str(item.get("source") or "Finnhub"),
                "url": item.get("url"),
            }
            for item in items[:4]
            if isinstance(item, dict) and _headline(item)
        ]
    except Exception as exc:
        brief["errors"].append(f"company_news: {exc}")

    try:
        trends = await news_svc.recommendation_trends(ticker)
        rows = _safe_list(trends.get("data") if isinstance(trends, dict) else None)
        if rows:
            latest = rows[0] if isinstance(rows[0], dict) else {}
            brief["recommendation"] = {
                "period": latest.get("period"),
                "buy": latest.get("buy"),
                "hold": latest.get("hold"),
                "sell": latest.get("sell"),
                "strongBuy": latest.get("strongBuy"),
                "strongSell": latest.get("strongSell"),
            }
        else:
            brief["recommendation"] = None
    except Exception as exc:
        brief["errors"].append(f"recommendation_trends: {exc}")

    try:
        market = await news_svc.market_news("general")
        items = _safe_list(market.get("data") if isinstance(market, dict) else None)
        brief["market_mood"] = [
            {
                "headline": _headline(item)[:140],
                "source": str(item.get("source") or "Finnhub"),
            }
            for item in items[:4]
            if isinstance(item, dict) and _headline(item)
        ]
    except Exception as exc:
        brief["errors"].append(f"market_news: {exc}")

    return brief


async def build_research_briefs(
    candidates: list[dict[str, Any]],
    *,
    limit: int = 5,
) -> list[dict[str, Any]]:
    briefs: list[dict[str, Any]] = []
    for candidate in candidates[:limit]:
        symbol = str(candidate.get("symbol") or candidate.get("tradingsymbol") or "").strip()
        if not symbol:
            continue
        briefs.append(await _research_one(symbol, candidate))
    return briefs


def _clip_bullets(raw: Any, *, limit: int = 4) -> list[str]:
    out: list[str] = []
    if isinstance(raw, str) and raw.strip():
        raw = [line.strip(" •-\t") for line in raw.splitlines() if line.strip()]
    if not isinstance(raw, list):
        return out
    for item in raw:
        text = str(item or "").strip()
        if not text:
            continue
        out.append(text[:220])
        if len(out) >= limit:
            break
    return out


def _fallback_bullets(brief: dict[str, Any], *, place: bool, confidence: float) -> list[str]:
    bullets: list[str] = []
    phase = brief.get("market_phase") or "regular"
    change = brief.get("change_pct")
    if change is not None:
        try:
            bullets.append(
                f"Premarket/session move: {float(change):+.2f}% ({phase}) — screener/eToro tape."
            )
        except (TypeError, ValueError):
            pass
    news = brief.get("news") or []
    if news:
        top = news[0]
        bullets.append(
            f"News: {top.get('headline')} ({top.get('source') or 'Finnhub'})."
        )
    rec = brief.get("recommendation")
    if isinstance(rec, dict) and any(rec.get(k) is not None for k in ("buy", "strongBuy", "hold", "sell")):
        bullets.append(
            "Analyst mix: "
            f"strongBuy={rec.get('strongBuy')} buy={rec.get('buy')} "
            f"hold={rec.get('hold')} sell={rec.get('sell')} (Finnhub)."
        )
    mood = brief.get("market_mood") or []
    if mood:
        bullets.append(f"Index/market mood: {mood[0].get('headline')} (Finnhub general).")
    if not bullets:
        bullets.append(
            f"{'Place' if place else 'Skip'} {brief.get('symbol')} at confidence {confidence:.0f} "
            "(limited research data available)."
        )
    return bullets[:4]


def _heuristic_decision(
    candidates: list[dict[str, Any]],
    briefs: list[dict[str, Any]],
    *,
    require_place_gate: bool,
) -> dict[str, Any]:
    """Deterministic fallback when Cursor agent is unavailable."""
    by_symbol = {
        str(b.get("etoro_symbol") or b.get("symbol") or "").upper(): b
        for b in briefs
    }
    best: dict[str, Any] | None = None
    best_score = -1e9
    for candidate in candidates:
        symbol = str(candidate.get("symbol") or "").upper()
        brief = by_symbol.get(symbol) or {}
        score = float(candidate.get("score") or 0)
        change = float(candidate.get("change_pct") or 0)
        news_n = len(brief.get("news") or [])
        conf = min(95.0, max(20.0, 45.0 + score * 0.05 + change * 2.0 + news_n * 3.0))
        if conf > best_score:
            best_score = conf
            best = {
                "candidate": candidate,
                "brief": brief,
                "confidence": round(conf, 1),
            }
    if not best:
        return {
            "selected": None,
            "place": False,
            "confidence": 0.0,
            "reasoning_bullets": ["No candidates available for analysis."],
            "sources": [],
            "decision_source": "fallback",
        }

    place = True
    if require_place_gate:
        place = float(best["confidence"]) >= _PLACE_CONFIDENCE_FLOOR
    bullets = _fallback_bullets(best["brief"], place=place, confidence=float(best["confidence"]))
    if require_place_gate and not place:
        bullets = [
            f"No-place: confidence {best['confidence']:.0f} below {_PLACE_CONFIDENCE_FLOOR:.0f} threshold."
        ] + bullets
        bullets = bullets[:4]

    sources = [{"label": "Finnhub", "detail": "company news / recommendations / market"}, {"label": "eToro", "detail": "instrument LTP"}]
    return {
        "selected": best["candidate"] if place else None,
        "place": place,
        "confidence": float(best["confidence"]),
        "reasoning_bullets": bullets,
        "sources": sources,
        "decision_source": "fallback",
        "symbol": best["candidate"].get("symbol"),
    }


def parse_one_percent_decision(assistant_text: str) -> dict[str, Any] | None:
    for block in extract_a2ui_blocks(assistant_text or ""):
        if block.get("component") not in {"OnePercentDecision", "TopStockPicks"}:
            continue
        props = block.get("props") or {}
        if block.get("component") == "TopStockPicks":
            picks = props.get("picks") or []
            if not picks or not isinstance(picks[0], dict):
                continue
            top = picks[0]
            return {
                "symbol": top.get("symbol"),
                "place": True,
                "confidence": top.get("confidence") if top.get("confidence") is not None else 70,
                "reasoning": top.get("reasoning") or top.get("recommendation"),
            }
        return {
            "symbol": props.get("symbol"),
            "place": props.get("place") if props.get("place") is not None else True,
            "confidence": props.get("confidence"),
            "reasoning": props.get("reasoning") or props.get("bullets"),
        }

    # Bare JSON fence fallback
    match = re.search(r"```json\s*(\{.*?\})\s*```", assistant_text or "", flags=re.DOTALL | re.IGNORECASE)
    if match:
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            nested = payload.get("a2ui") if isinstance(payload.get("a2ui"), dict) else None
            props = (nested or {}).get("props") if nested else payload
            if isinstance(props, dict) and props.get("symbol"):
                return {
                    "symbol": props.get("symbol"),
                    "place": props.get("place") if props.get("place") is not None else True,
                    "confidence": props.get("confidence"),
                    "reasoning": props.get("reasoning") or props.get("bullets"),
                }
    return None


def _match_candidate(candidates: list[dict[str, Any]], symbol: str | None) -> dict[str, Any] | None:
    want = str(symbol or "").strip().upper()
    if not want:
        return None
    base = want.split(".", 1)[0]
    for candidate in candidates:
        sym = str(candidate.get("symbol") or "").upper()
        if sym == want or sym.startswith(f"{base}.") or sym.split(".", 1)[0] == base:
            return candidate
    return None


def _build_prompt(
    *,
    session: dict[str, Any],
    candidates: list[dict[str, Any]],
    briefs: list[dict[str, Any]],
    require_place_gate: bool,
) -> str:
    config = session.get("config") or {}
    mode_note = (
        "User supplied SPECIFIC stocks — ignore screener ranks. Decide place vs no-place "
        f"with a confidence score. Only place if confidence >= {_PLACE_CONFIDENCE_FLOOR:.0f}."
        if require_place_gate
        else "Pick the single best name from the shortlist for a same-day ~1% capital target trade."
    )
    brief_json = json.dumps(briefs, default=str)[:12_000]
    cand_json = json.dumps(
        [
            {
                "symbol": c.get("symbol"),
                "token": c.get("symboltoken"),
                "name": c.get("instrument_name") or c.get("name"),
                "price": c.get("close"),
                "score": c.get("score"),
                "change_pct": c.get("change_pct"),
            }
            for c in candidates[:6]
        ],
        default=str,
    )
    return f"""You are selecting a stock for a durable 1% daily target trading session on eToro.

Account: {session.get('account_env')} · capital ${float(config.get('capital') or 1000):.0f} · target {float(config.get('target_pct') or 1):.1f}%
TP {float(config.get('take_profit_pct') or 1.5):.1f}% / SL {float(config.get('stop_loss_pct') or 2):.1f}%

{mode_note}

Research already gathered (Finnhub news, recommendations, market mood; eToro prices). You may use web search for index/sector mood (SPX, NDX, sector ETFs) if needed.

Candidates JSON:
{cand_json}

Research briefs JSON:
{brief_json}

Emit EXACTLY one fenced JSON a2ui block and nothing else after it:
```json
{{"a2ui":{{"component":"OnePercentDecision","props":{{"symbol":"AAPL.US","place":true,"confidence":72,"reasoning":["Premarket: … (source)","News: … (Finnhub)","Sector/indices: …","Mood: …"]}}}}}}
```

Rules:
- symbol MUST be one of the candidate symbols above (exact eToro tradingsymbol when possible).
- reasoning: 3–4 short bullets, each citing a source (Finnhub / eToro / web).
- place=false when the setup is weak{f' or confidence < {_PLACE_CONFIDENCE_FLOOR:.0f}' if require_place_gate else ''}.
- Do NOT place orders yourself — decision only.
"""


async def select_with_agent(
    *,
    session_id: str,
    store: Any,
    session: dict[str, Any],
    candidates: list[dict[str, Any]],
    require_place_gate: bool = False,
) -> dict[str, Any]:
    """Research top candidates and ask Cursor agent (or fallback) to pick / place."""
    if not candidates:
        return {
            "selected": None,
            "place": False,
            "confidence": 0.0,
            "reasoning_bullets": ["No candidates to analyze."],
            "sources": [],
            "decision_source": "none",
        }

    store.append_event(
        session_id,
        "agent_research_started",
        state="selecting",
        payload={
            "candidate_count": len(candidates),
            "symbols": [c.get("symbol") for c in candidates[:8]],
            "focus_mode": require_place_gate,
        },
    )

    briefs = await build_research_briefs(candidates, limit=5)
    store.append_event(
        session_id,
        "agent_research_ready",
        state="selecting",
        payload={
            "briefs": [
                {
                    "symbol": b.get("symbol"),
                    "etoro_symbol": b.get("etoro_symbol"),
                    "news_count": len(b.get("news") or []),
                    "has_recommendation": bool(b.get("recommendation")),
                    "market_mood_count": len(b.get("market_mood") or []),
                    "errors": b.get("errors") or [],
                }
                for b in briefs
            ],
        },
    )

    cursor_key = os.getenv("CURSOR_API_KEY", "").strip()
    assistant_text = ""
    decision: dict[str, Any] | None = None

    if cursor_key:
        from control_plane.trading_session_agent_common import stream_agent_prompt

        adapter = OnePercentAgentStoreAdapter(store, state="selecting")
        prompt = _build_prompt(
            session=session,
            candidates=candidates,
            briefs=briefs,
            require_place_gate=require_place_gate,
        )
        try:
            assistant_text = await stream_agent_prompt(
                session_id=session_id,
                store=adapter,
                state="selecting",
                prompt=prompt,
                interaction_mode="ask",
                web_search_enabled=True,
            )
            decision = parse_one_percent_decision(assistant_text)
        except Exception as exc:
            log.exception("[1PC] agent selection failed session=%s", session_id)
            store.append_event(
                session_id,
                "agent_selection_failed",
                state="selecting",
                payload={"error": str(exc)},
            )

    if not decision:
        fallback = _heuristic_decision(
            candidates,
            briefs,
            require_place_gate=require_place_gate,
        )
        store.append_event(
            session_id,
            "agent_selection_fallback",
            state="selecting",
            payload={
                "reason": "no_agent_decision" if cursor_key else "no_cursor_api_key",
                "confidence": fallback.get("confidence"),
                "place": fallback.get("place"),
            },
        )
        return fallback

    symbol = str(decision.get("symbol") or "")
    matched = _match_candidate(candidates, symbol) or candidates[0]
    try:
        confidence = float(decision.get("confidence") if decision.get("confidence") is not None else 70)
    except (TypeError, ValueError):
        confidence = 70.0
    place = bool(decision.get("place"))
    if require_place_gate and confidence < _PLACE_CONFIDENCE_FLOOR:
        place = False
    bullets = _clip_bullets(decision.get("reasoning"), limit=4)
    brief = next(
        (
            b
            for b in briefs
            if str(b.get("etoro_symbol") or "").upper() == str(matched.get("symbol") or "").upper()
            or str(b.get("symbol") or "").upper() == str(matched.get("symbol") or "").split(".", 1)[0].upper()
        ),
        briefs[0] if briefs else {},
    )
    if not bullets:
        bullets = _fallback_bullets(brief, place=place, confidence=confidence)

    return {
        "selected": matched if place else None,
        "place": place,
        "confidence": confidence,
        "reasoning_bullets": bullets,
        "sources": [
            {"label": "Finnhub", "detail": "news / recommendations / market"},
            {"label": "eToro", "detail": "instrument resolve + LTP"},
            {"label": "Cursor agent", "detail": "selection decision"},
        ],
        "decision_source": "agent",
        "symbol": matched.get("symbol"),
        "assistant_text": (assistant_text or "")[:4000],
    }
