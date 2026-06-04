# Layers and modules

The repo uses a **dual layout**: legacy root packages plus `src/backtrading/` shims toward the target modular layout.

## Target layers vs current code

```mermaid
flowchart TB
  subgraph L5 [L5 Application roots]
    Server[api/server.py]
    LiveSrv[api/live_server.py]
    AppsCP[src/backtrading/apps/control_plane shim]
    AppsLE[src/backtrading/apps/live_engine shim]
    CLI[src/backtrading/commands]
  end
  subgraph L4 [L4 Integration]
    CursorMod[api/cursor_agent + cursor_sdk_bridge]
    TelegramMod[event/telegram_*]
    Agentic[src/backtrading/agentic]
  end
  subgraph L3 [L3 Domain orchestration]
    CP[control_plane/]
    OrchEng[src/backtrading/orchestration/engines shim]
    OrchSch[src/backtrading/orchestration/scheduling shim]
    OrchRes[src/backtrading/orchestration/research shim]
    MCPRoot[mcps/catalog facade]
  end
  subgraph L2 [L2 Infrastructure]
    Brokers[brokers/angel etoro adapters]
    Events[event/ db + order_activity_store]
    Obs[src/backtrading/observability]
  end
  subgraph L1 [L1 Core trading]
    Strategies[strategies/]
    Managers[managers/]
    Indicators[indicators/]
    CTShim[src/backtrading/core_trading shims]
  end
  subgraph L0 [L0 Kernel]
    Iface[brokers/interfaces.py protocols + dataclasses]
    StratCfg[strategy_config.StrategyConfig]
    EventBus[src/backtrading/core_trading/events/EventBus]
  end
  L5 --> L4
  L5 --> L3
  L4 --> L3
  L3 --> L2
  L2 --> L1
  L1 --> L0
```

## Python package map

```mermaid
flowchart LR
  subgraph api_pkg [api/]
    server[server.py]
    live[live_server.py]
    cursor_a[cursor_agent.py]
    cursor_b[cursor_sdk_bridge.py]
    mcp[control_plane_mcp*.py]
    research[ai_research_routes.py]
    watch[watchlist_routes + feed]
    robo[manual_robo_routes.py]
  end
  subgraph cp_pkg [control_plane/]
    reg[engine_registry]
    epm[engine_process_manager]
    sched[execution_scheduler]
    tsched[trading_schedule]
    research_store[ai_research_store]
    wlist[watchlist_store]
    links[execution_source_links]
  end
  subgraph mgr_pkg [managers/]
    se[strategy_executor]
    tm[trading_manager]
    om[order_manager]
    tp[tick_provider]
  end
  subgraph strat_pkg [strategies/]
    base[base.BaseStrategy]
    factory[factory.create_strategy]
    one[one_percent_strategy]
    rsi[rsi_bollinger_strategy]
  end
  subgraph brk_pkg [brokers/]
    iface[interfaces]
    angel[angel/*]
    etoro[etoro/* + adapters/portfolio]
  end
  subgraph evt_pkg [event/]
    em[event_manager]
    dbw[db_event_consumer]
    oas[order_activity_store]
    tg[telegram_*]
    sev[strategy_events]
  end
  server --> cp_pkg
  server --> evt_pkg
  server --> brk_pkg
  live --> mgr_pkg
  live --> strat_pkg
  live --> evt_pkg
  live --> brk_pkg
  se --> tm
  se --> strat_pkg
  epm --> live
```

## Dependency rules (target)

| Layer | May import |
|-------|------------|
| L0 | stdlib, typing |
| L1 | L0 |
| L2 | L0–L1 |
| L3 | L0–L2 via facades |
| L4 | L3 interfaces + L0 types |
| L5 | facades + wiring only |

Forbidden: `core_trading` → telegram/cursor/apps; `apps` → concrete `brokers.angel` directly.
