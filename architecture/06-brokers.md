# Brokers subsystem

## Structure

```mermaid
flowchart TB
  subgraph protocols [brokers/protocols.py]
    TC[TickClient]
    TL[TickListener]
    OAL[OrderActivityListener]
  end
  subgraph angel [brokers/angel/]
    AC[AngelClient]
    ATC[AngelOneTradingClient]
    AFC[AngelWebsocketFeedClient]
    ASC[AngelWebsocketOrderStatusClient]
    WSE[ws_order_events mappers]
  end
  subgraph etoro [brokers/etoro/]
    EC[EtoroClient]
    ETC[EtoroTradingClient]
    EFC[feed_client]
    Adapters[adapters/portfolio.py]
  end
  subgraph fake [fake path]
    FTC[FakeTradingClient in tests/fake_test_client]
    Shim[src/backtrading/brokers/fake]
  end
  ATC ..|> TC
  FTC ..|> TC
  ETC ..|> TC
  server[api/server] --> Adapters
  server --> ATC
  server --> ETC
  LiveEngine --> ATC
  LiveEngine --> ETC
  LiveEngine --> FTC
```

## Angel (`brokers/angel/`)

| File | Class | Role |
|------|-------|------|
| `client.py` | `AngelClient` | Base SmartAPI session |
| `trading_client.py` | `AngelOneTradingClient` | Orders, LTP (`TickClient`) |
| `feed_client.py` | `AngelWebsocketFeedClient` | Tick WS feed |
| `status_client.py` | `AngelWebsocketOrderStatusClient` | Order status WS |
| `ws_client.py` | `AngelOneWebSocketClient` | WS helper |
| `ws_order_events.py` | mappers | Order activity mapping |
| `feed_config.py` | helpers | Feed mode normalization |

## eToro (`brokers/etoro/`)

| File | Class | Role |
|------|-------|------|
| `client.py` | `EtoroClient`, `EtoroApiError` | HTTP API |
| `trading_client.py` | `EtoroTradingClient`, bracket variant | Trading |
| `feed_client.py` | feed client | Market data |
| `env.py` | loaders | `.demo.env` / `.live.env` |
| `adapters/portfolio.py` | pure functions | CP portfolio/search row mapping |
| `angel/adapters/portfolio.py` | `angel_portfolio_rows_from_holdings` | Angel holdings |
| `fake/adapters/portfolio.py` | `fake_portfolio_rows` | Demo rows |
| [`adapters/README.md`](../brokers/adapters/README.md) | index | Per-broker adapter map |

## Fake broker

- **Runtime:** `api.live_server --fake` or `broker=fake`
- **Implementation:** `tests/fake_test_client.py` (`FakeTradingClient`, `FakeTickGenerator`)
- **Package shim:** `src/backtrading/brokers/fake`
- **Registry:** `src/backtrading/brokers/registry.py`

See `docs/fake-broker.md`.

## Plugin registry (target)

```python
# src/backtrading/brokers/registry.py
register("fake", factory)
get("etoro")  # -> factory or None
```
