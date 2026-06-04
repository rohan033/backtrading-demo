# Event bus contract

Domain events flow through a bounded async queue so the trading loop never awaits slow sinks.

## Producers

- `StrategyExecutor`, `OrderManager`, broker adapters, engine lifecycle hooks

## API

- `emit(event: DomainEvent)` — non-blocking enqueue
- Sinks implement `EventSink` and subscribe at app lifespan

## Rules

1. `emit()` uses `asyncio.Queue(maxsize=1000)`; producers do not await sinks.
2. Queue full → log warning, drop event, increment `events_dropped_total`.
3. `DomainEvent` is a frozen dataclass (L0); no FastAPI/Telegram imports.
4. Sinks are injected in `live_engine` / `control_plane` lifespan.
5. `SqliteEventSink` runs DB I/O on a dedicated thread + event loop.
6. Per-sink timeouts when draining; one slow sink must not block others.

## Implementation

`backtrading.core_trading.events.bus.EventBus`
