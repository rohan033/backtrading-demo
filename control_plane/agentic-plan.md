Session trading agent — implementation plan

Handoff plan for backtrading-demo. Assumes the existing control plane, event bus (EventManager), broker adapters (including eToro), KillSwitch/RiskGuard, and Overview page (screeners, Halts panel, Suggestions panel) are already in place and should be reused, not rebuilt.

Where a decision had to be made rather than derived from prior discussion, it's marked Decision: — treat these as defaults to override, not fixed requirements.

1. Two agents
Market hunter agent (background) — runs continuously, independent of any session. Watches the existing screeners/scanners and the Halts panel, scores candidates, emits suggestion events. Has no opinion about open positions and never places or closes orders itself.
Session trading agent (foreground) — owns one trading session: entry decisions, sizing, exit state per position, rotation, and the autonomous stop rule. Consumes market hunter suggestions as input events; is the only thing allowed to place or close orders.

Suggested placement against the documented L0–L5 layering: market hunter as a long-running task under orchestration/research, session trading agent under orchestration/engines, both talking through the existing event bus. Confirm against the current contents of orchestration/ before committing to exact module names — the layering in ARCHITECTURE.md is target-state, not necessarily what's implemented yet.

2. Market hunter agent

Inputs: existing screener panels (Stock Catalyst PM Movers, Pre-market Movers, Penny Stocks Trending Up, Todays Trending, Hot stocks), Halts panel.

Output: a suggestion event per candidate:

suggestion {
  ticker, score (0-100), source_screener, reason,
  price, spread_pct, generated_at
}

Filtering before emitting:

Drop anything currently on the Halts panel.
Drop anything below a configurable minimum score.
Drop anything whose spread as a % of price exceeds a configurable ceiling (several of the sub-$1 names in the current Suggestions panel have spreads wide enough to matter — filter on this, not just on % gain).
Don't re-emit a suggestion for a ticker already open in the requesting session within a cooldown window, to avoid the session agent getting spammed into re-evaluating the same name every cycle.

Cadence: match or tighten the existing screener refresh interval. Flag if 5-minute refresh is too slow for the fastest-moving candidates — this is a tuning question, not something to hardcode now.

3. Session trading agent
3.1 Session lifecycle

Persist per session: session_id, start_balance, status (running / stopped), started_at, stopped_at, stop_reason.

Tables: sessions, session_events (append-only log — every suggestion received, order placed, state transition, reconciliation mismatch, manual action), session_positions.

3.2 Entry pipeline
Consume market hunter suggestions above the session's confidence threshold.
Pull per-candidate data from the broker API in parallel (asyncio.gather), not serially.
Size positions: confidence-weighted allocation, hard per-position cap, hard total-session-exposure cap, and a correlation/sector-overlap guard so a batch of thematically-similar candidates doesn't become one concentrated bet wearing several tickers.
Place orders in parallel. Every order must carry an explicit stop-loss value at placement time — no position is allowed to exist without one.
3.3 Exit / hold state machine (per open position)

States: Running → Weakening → Exit, re-evaluated on every 5-minute candle close, plus immediately on any halt or news event for that ticker.

Running — last N 5-min candles show higher lows (uptrend structure intact). Trailing stop stays wide (Decision: start at 3x ATR off the peak, make it configurable).
Weakening — first candle whose low undercuts the prior candle's low. Trim a configurable fraction of the position, tighten the trail (Decision: 1x ATR). If the next candle reconfirms a higher low, return to Running and widen the trail back out.
Exit — close the remainder. Reached either from Weakening (trail hit) or directly from Running via a fast path on: a down-halt while held, or news classified as a dilution/offering announcement.
Up-halts are not a directional trigger by default — treat as a forced re-evaluation point with wider slippage tolerance on resumption. Decision needed: backtest halt-resumption behavior for this stock class before giving up-halts any directional weight.
This state machine can only tighten or exit earlier — it sits above the hard per-position stop-loss from step 3.2 and can never loosen or disable it.
3.4 Rotation

Triggered by a market hunter suggestion arriving for a session that's already fully allocated. Only close position A to open candidate B if B's score exceeds A's remaining marginal edge (A's current momentum score, net of estimated slippage/spread cost to exit) by a configurable margin. Don't rotate on every incoming suggestion — that's just churn.

3.5 Autonomous stop

Deterministic circuit breaker, not left to agent judgment: session realized PnL drawdown beyond a configurable % of start_balance, or N consecutive losing rotations. On trigger: block new entries, write stop_reason to the session, keep managing already-open positions through the normal exit state machine. Decision: auto-stop does not force- liquidate open positions — that stays a manual action via the STOP button. Override this if you'd rather it liquidate everything immediately.

4. Broker reconciliation (don't trust acks)
Position state machine

pending_open → open → pending_close → closed, with a failed terminal state for rejected orders.

Idempotency
Every open/close action carries a unique intent_id. Before placing an order, check there's no pending_open/pending_close already in flight for that position — this is what stops duplicate opens/closes.
Debounce: a position that just transitioned state is not re-evaluated for the opposite action for a minimum cooldown (a few seconds), so signals oscillating right at a threshold don't cause flapping.
Reconciliation loop

Runs continuously and independently of whatever the session agent is otherwise doing — including while idle, not just after an action.

Every 30–60s (configurable): poll the broker's actual positions/orders for the session's portfolio, diff against session_positions.
Broker shows closed, internal shows open → mark internal closed, log a reconciliation event, compute realized PnL from the broker's actual fill data (never assume the fill price).
Broker shows open, internal stuck in pending_close → retry the close; alert after a configurable number of failed retries.
Order rejected or silently failed → mark failed, don't treat it as an open position, release the capital that was allocated to it.
Every pass and every mismatch is written to session_events, so the session's audit log has an actual record of drift, not just of intended actions.
5. Agent page UI

Reuse, don't reinvent. Pull the card style, typography, spacing, and color coding already used on the Overview page (screener tiles, confidence badges, Halts panel) rather than designing a new visual system.

No AGUI. This should read like the rest of the trading terminal — dense, scannable, numbers-first — not like a chat window with an assistant persona. No message bubbles, no conversational framing for the event log.

Layout:

Sticky header: session id, live clock (same pattern as the existing top bar), STOP button.
One compact inline stat row, not cards: trades placed, realtime PnL, invested amount, win rate.
Left: event timeline, own scroll container. Each row is one line — a colored dot by event type (entry/exit/suggestion/reconciliation/error), relative time ("2m ago", absolute time on hover), short text. Collapsed by default; click a row to expand its meta. This is the single biggest lever against information overload — resist the urge to show full detail inline for every event.
Right: positions table (table, not cards) — ticker, live price (websocket-driven, subtle flash on tick), buy price, PnL (green/red), current stop-loss value, close button. Market hunter's live suggestions feed sits below or beside it, reusing the existing confidence-badge style.
Each panel scrolls independently; the page itself doesn't scroll for the live areas.
6. Suggested build order
Data model + reconciliation loop — safest foundation, nothing else should be trusted until this exists.
Market hunter suggestion emitter wired to the existing screeners.
Session agent entry pipeline + sizing allocator.
Exit state machine.
Rotation logic.
Agent page UI.
Telegram wiring for alerts (and optionally inline approve/deny on entries above a size threshold).