# Use eToro WebSocket for live engine price ticks

**Status:** todo  
**Priority:** high (live chart + strategy triggers broken when HTTP rates return `ltp=0`)

## Current behavior

- **Live engine** (`api/live_server.py`) uses `TickProvider` + `EtoroTradingClient` to poll eToro REST every ~1s:
  - `GET /market-data/instruments/rates?instrumentIds=...`
  - `EtoroTradingClient.aget_ltp_bulk()` → `_rate_ltp()` parses `lastExecution` / `bid` / `ask`
- Valid ticks go to `_on_tick()` → strategy listeners + broadcast on **our** app WebSocket (`/ws/live` → browser chart).
- Invalid ticks (`ltp <= 0`) are dropped in `_on_tick()` with `[TICK] Ignoring invalid tick` — nothing reaches the chart (“Connected — no prices received”).
- **eToro WebSocket is already used elsewhere, but not for live-engine prices:**
  - Launch/create **market preview** → `EtoroWebsocketFeedClient` (`api/server.py`)
  - **Order/portfolio status** → `EtoroHybridPortfolioStatusClient` (WS + REST fallback)
- **Bracket mode** only swaps the trading client (`EtoroBracketTradingClient`) and status handling; it still polls HTTP rates for ticks.

## What we want

- Wire the **live engine** to use **`EtoroWebsocketFeedClient`** (`wss://ws.etoro.com/ws`, topic `Trading.Instrument.Rate`) as the primary price source for strategy execution.
- Replace (or bypass) `TickProvider` + `aget_rates` polling for eToro live runs.
- On each WS tick: forward to the same `_on_tick()` path (strategy executor, order manager where applicable, `/ws/live` broadcast).
- Subscribe/unsubscribe instruments as executors register and deregister.
- Keep REST rates only as an optional fallback if WS is down or a symbol has no stream.
- Apply for **standard and bracket** eToro client modes.

## Key files

| Area | File |
|------|------|
| Live engine wiring | `api/live_server.py` |
| HTTP poll (replace) | `managers/tick_provider.py`, `brokers/etoro/trading_client.py` |
| WS feed (reuse) | `brokers/etoro/feed_client.py` → `EtoroWebsocketFeedClient` |
| Preview reference impl | `api/server.py` → `_run_market_preview` |

## Done when

- Live eToro executions receive real-time ticks from eToro WS, not 1s HTTP poll.
- Chart shows “Live prices flowing” and strategies trigger on WS ticks.
- No repeated `[TICK] Ignoring invalid tick ... ltp=0.0` from empty HTTP rates responses.
- Reconnect/resubscribe behavior is handled on WS disconnect.
