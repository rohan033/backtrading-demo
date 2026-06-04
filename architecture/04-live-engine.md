# Live engine (data plane)

Entry: `python -m api.live_server` (spawned by `EngineProcessManager` on deploy).

## Class graph

```mermaid
classDiagram
  class LiveEngine {
    +dict executors
    +ConnectionManager ws_manager
    +start()
    +shutdown()
  }
  class ConnectionManager {
    +list active_connections
    +broadcast()
  }
  class StrategyExecutor {
    +TickListener
    +TradingManager trading_manager
    +BaseStrategy strategy
    +handle_tick()
  }
  class TradingManager {
    +OrderActivityListener
    +EventManager event_manager
  }
  class OrderManager {
    +register_listener()
  }
  class TickProvider {
    +feeds ticks
  }
  class EventManager {
    +emit events
  }
  class DbEventWriter {
    +SQLite live_events.db
  }
  class AngelOneTradingClient
  class EtoroTradingClient
  class FakeTradingClient

  LiveEngine --> ConnectionManager
  LiveEngine --> StrategyExecutor
  LiveEngine --> TradingManager
  LiveEngine --> OrderManager
  LiveEngine --> TickProvider
  LiveEngine --> EventManager
  EventManager --> DbEventWriter
  StrategyExecutor --> TradingManager
  OrderManager --> TradingManager
  LiveEngine ..> AngelOneTradingClient
  LiveEngine ..> EtoroTradingClient
  LiveEngine ..> FakeTradingClient
```

## Tick → order flow

```mermaid
sequenceDiagram
  participant Feed as TickProvider_or_WS
  participant SE as StrategyExecutor
  participant Strat as BaseStrategy
  participant TM as TradingManager
  participant Broker as TradingClient
  participant EM as EventManager
  participant DB as DbEventWriter
  participant WS as ConnectionManager

  Feed->>SE: TickData
  SE->>Strat: provide_signal
  Strat-->>SE: TradeSignal
  SE->>TM: execute signal
  TM->>Broker: place order
  TM->>EM: emit lifecycle
  EM->>DB: persist
  TM->>WS: broadcast event
```

## Key REST / WS paths

| Path | Handler area in `api/live_server.py` |
|------|--------------------------------------|
| `GET /health` | Engine health / degraded |
| `GET /api/live/engine-info` | Registry heartbeat payload |
| `GET /api/live/executors` | Running strategy executors |
| `POST /api/live/executors` | Register executor |
| `GET /api/live/events` | Event log |
| `WS /ws/live` | Live stream to UI |

## CLI flags

`--fake`, `--port`, `--env`, `--engine-id`, `--control-url`, `--broker`, `--strategy-name`, `--symbol`, `--token`, `--client-mode`, `--feed-mode`
