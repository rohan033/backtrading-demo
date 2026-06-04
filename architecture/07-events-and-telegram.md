# Events and Telegram

## Live event path (today)

```mermaid
flowchart LR
  subgraph live_events [Live path]
    TM[TradingManager]
    EM[EventManager]
    DB[DbEventWriter live_events.db]
    OAS[OrderActivityStore]
    TM --> EM --> DB
    TM --> OAS
  end
```

| Class | File | Role |
|-------|------|------|
| `EventManager` | `event/event_manager.py` | Emit strategy/order events |
| `DbEventWriter` | `event/db_event_consumer.py` | SQLite persistence |
| `OrderActivityStore` | `event/order_activity_store.py` | Order activity queries |
| `DbOrderActivityListener` | same file | Listener adapter |

## Platform notifications (control plane)

```mermaid
flowchart LR
  PN[platform_notifier] --> TL[TelegramEventListener]
  SE[strategy_events] --> SF[telegram_format]
  PN --> SE
  TL --> SF
```

| Module | Role |
|--------|------|
| `event/strategy_events.py` | Lifecycle constants, detail builders |
| `event/platform_notifier.py` | Bridge engine events → Telegram |
| `event/telegram_listener.py` | `TelegramEventListener` |
| `event/telegram_format.py` | HTML formatting, skill loader |

## Target EventBus

```mermaid
flowchart LR
  subgraph producers [Producers]
    SE[StrategyExecutor]
    TM[TradingManager]
  end
  subgraph bus [EventBus]
    Q[asyncio.Queue bounded]
  end
  subgraph sinks [EventSink]
    SQL[SqliteEventSink]
    OBS[ObservabilitySink]
  end
  producers --> bus --> sinks
```

Spec: `docs/event-bus.md`, implementation: `src/backtrading/core_trading/events/bus.py`.

## Telegram agent stack

```mermaid
flowchart TB
  Inbound[telegram_inbound poller] --> Cmd[telegram_commands]
  Cmd --> TCA[telegram_cursor_agent]
  TCA --> Bridge[cursor_sdk_bridge]
  TCA --> Prompt[telegram_agent_prompt]
  Prompt --> Format[telegram_format]
  Format --> Skill[agentic/skills/telegram-channel-html]
  TCA --> Client[telegram_client send_html]
```

| Class / type | File |
|--------------|------|
| `TelegramConfig` | `telegram_config.py` |
| `InboundAgentRequest` | `telegram_commands.py` |
| `TelegramCursorAgent` | `telegram_cursor_agent.py` |
| `TelegramInboundPoller` | `telegram_inbound.py` |

Shim package: `src/backtrading/telegram/`.
