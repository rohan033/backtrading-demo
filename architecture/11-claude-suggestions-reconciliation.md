# Claude Code suggestions — reconciliation

External refactor ideas (terminal table + gap-map image) mapped to **backtrading-demo**. This repo does not use Claude’s literal folder names.

## Summary

| Claude suggestion | Backtrading equivalent | Action |
|-------------------|------------------------|--------|
| `backend/protocols/` | [`brokers/protocols.py`](../brokers/protocols.py) (was `interfaces.py`) | **Adopted** |
| `backend/adapters/` | [`brokers/{angel,etoro,fake}/adapters/`](../brokers/) | **Adopted** (per broker, not top-level `backend/`) |
| `tracking/` package | `event/order_activity_store.py`, `TradingManager.order_tracking*` | **Defer** — document only; no `tracking/` folder |
| `core/logic/` | `src/backtrading/core_trading/` | **Reject** wrong name; use existing package |
| `mv core/ -> core/logic/` | N/A — [`examples/legacy/core/`](../examples/legacy/core/) | **Archived** unused stubs |
| Gap map: schema analysis, `RouteManager`, repos | Not this product | **Reject** |
| Safety trading | Not in codebase | **Defer** (future feature) |

## What we adopted

### Protocols (Claude: `backend/protocols`)

- Canonical module: `brokers/protocols.py` — `TickData`, `TickClient`, `TickListener`, `OrderActivityListener`, etc.
- Legacy import: `brokers/interfaces` re-exports from `protocols` (deprecation path).

### Adapters (Claude: `adapters/protocols`, per-broker adapters)

- `brokers/etoro/adapters/portfolio.py` — eToro search/portfolio row mapping
- `brokers/angel/adapters/portfolio.py` — Angel holdings rows
- `brokers/fake/adapters/portfolio.py` — fake broker demo rows
- `brokers/adapters/README.md` — index (no second implementation layer)

Control plane [`api/server.py`](../api/server.py) imports adapters; HTTP paths unchanged.

### Core stubs (Claude: `core/logic`)

- Old [`core/`](../examples/legacy/core/) contained unused `TradingContext` / `OrderService` stubs.
- Moved to `examples/legacy/core/` — **not** renamed to `core/logic/`.

## What we did not do

- Create `backend/`, `tracking/`, or `core/logic/` trees
- Implement safety trading
- Extract `order_tracking` from `TradingManager` (future: `core_trading/execution/order_tracker.py`)
- Schema / repository / routing-agent layout from the gap-map screenshot

## Related docs

- [02-layers-and-modules.md](02-layers-and-modules.md)
- [06-brokers.md](06-brokers.md)
- [10-legacy-and-package.md](10-legacy-and-package.md)
