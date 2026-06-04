# Frontend and API contract

The UI must keep stable paths and JSON shapes; see `docs/ui-smoke.md` for manual verification.

## Vite proxy (`frontend/vite.config.js`)

```mermaid
flowchart LR
  subgraph vite_proxy [Vite :3000]
    P1["/api → localhost:8000"]
    P2["/ws → localhost:8000"]
    P3["/api/live → localhost:8080"]
    P4["/ws/live → localhost:8080"]
  end
  subgraph cp [Control plane :8000]
    R1["/api/control/*"]
    R2["/ws/control/*"]
    R3["/ws/backtest"]
  end
  subgraph live [Live engine dynamic port]
    L1["/api/live/*"]
    L2["/ws/live"]
  end
  P1 --> cp
  P2 --> cp
  P3 --> live
  P4 --> live
```

Note: Default Vite live proxy targets `:8080`; deployed engines often use `:9000–9999` via control-plane WS proxy `/ws/control/engines/{id}/live`.

## Frontend consumers (examples)

| Frontend module | Backend paths |
|-----------------|---------------|
| `lib/portfolio-cache.ts` | `GET /api/control/portfolio` |
| `lib/aiResearch.ts` | `/api/control/ai-research` |
| `lib/useCursorAgentChat.ts` | `WS /ws/control/cursor-agent` |
| `ExecutionWorkspace.jsx` | `/api/control/executions`, engine WS proxy |
| `LiveTrading.jsx` | `/api/live`, `/ws/live` |
| `lib/controlMarketWs.ts` | `WS /ws/control/market` |
| `pages/insights/LiveServersPage.tsx` | `GET /api/control/engines` |

## Engine registry fields (UI contract)

Engines returned by `/api/control/engines` should preserve:

- `id`, `status`, `broker`, `account_env`
- `api_base_url`, `ws_url`
- `heartbeatFresh`, `last_heartbeat_at` (or equivalent)
- `port`, `host`, `metadata`

Documented in `docs/observability.md`.
