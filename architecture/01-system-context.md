# System context (runtime)

## Diagram

```mermaid
flowchart TB
  subgraph dev [make_dev]
    FE[frontend Vite :3000]
    CP[api.server FastAPI :8000]
  end
  subgraph deploy [on_strategy_deploy]
    EPM[EngineProcessManager]
    LE[api.live_server :9000-9999]
  end
  User[Browser] --> FE
  FE -->|"/api /ws"| CP
  FE -->|"/api/live /ws/live"| LE
  CP --> EPM
  EPM -->|subprocess| LE
  LE -->|heartbeat| CP
  CP --> Angel[brokers.angel]
  CP --> Etoro[brokers.etoro]
  LE --> Angel
  LE --> Etoro
  LE --> Fake[tests.fake_test_client]
  CP --> Cursor[cursor_sdk via api.cursor_agent]
  CP --> TG[event.telegram_*]
  CP --> MCP[FastMCP /mcp]
```

## Processes

| Process | Entry | Role |
|---------|--------|------|
| Control plane | `uvicorn api.server:app` | Registry, executions, portfolio/search, AI research, WS proxy, backtest |
| Live engine | `python -m api.live_server` | Ticks, strategies, orders, `/api/live/*`, `/ws/live` |
| Frontend | Vite `:3000` | Proxies to CP and live engine |

## Commands

```bash
make dev    # CP :8000 + frontend :3000
make cp     # control plane only
make fe     # frontend only
```

Live engines are spawned on strategy deploy via `control_plane/engine_process_manager.py`, not by `make dev`.
