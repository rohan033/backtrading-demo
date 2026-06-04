# Domain models and protocols (L0)

## Class diagram

```mermaid
classDiagram
  class TickData {
    +str symbol
    +str token
    +float ltp
    +str exchange
  }
  class Subscription {
    +str exchange
    +str symbol
    +str token
  }
  class LTPData {
    +str exchange
    +str symbol
    +str token
    +float ltp
  }
  class OrderActivity {
    +str activity_type
    +str order_id
    +dict raw
  }
  class TradeSignal {
    +str action
    +float quantity
  }
  class StrategyConfig {
    +float long_percent
    +float short_percent
    +str symbol
    +str strategy_type
  }
  class DomainEvent {
    +str action
    +dict details
    +str order_id
  }

  class TickClient {
    <<Protocol>>
    +aget_ltp_bulk()
  }
  class TickListener {
    <<Protocol>>
    +enqueue_tick()
    +handle_tick()
  }
  class OrderActivityListener {
    <<Protocol>>
    +enqueue_order_activity()
  }
  class EventSink {
    <<Protocol>>
    +handle()
  }
  class BaseStrategy {
    <<abstract>>
    +provide_signal()
  }

  TickListener <|.. StrategyExecutor
  BaseStrategy <|-- OnePercentStrategy
  BaseStrategy <|-- RsiBollingerStrategy
  StrategyExecutor --> BaseStrategy
  StrategyExecutor --> StrategyConfig
  StrategyExecutor --> TickData
  BaseStrategy --> TradeSignal
  EventSink <|.. SqliteEventSink
  EventBus --> DomainEvent
  EventBus --> EventSink
```

## Type index

| Type | Location | Purpose |
|------|----------|---------|
| `TickData`, `Subscription`, `LTPData`, `OrderActivity` | `brokers/protocols.py` (`interfaces` shim) | Broker/tick contracts |
| `TradeSignal` | `strategies/base.py` | Strategy output |
| `StrategyConfig` | `strategy_config.py` | Runtime strategy parameters |
| `DomainEvent`, `EventBus` | `src/backtrading/core_trading/events/bus.py` | Async event pipeline (target; partial wiring) |
| `Tick` | `tick.py`, `__init__.py` | Legacy backtest model |

## Strategy registry

`strategies/factory.py` → `create_strategy(config)`:

- `one-percent` (default) → `OnePercentStrategy`
- `rsi-bollinger` aliases → `RsiBollingerStrategy`
