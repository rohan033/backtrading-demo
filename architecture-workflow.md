# Backtrading Architecture Workflow

This diagram shows the high-level runtime architecture and how execution creation, data-plane lifecycle, broker communication, heartbeats, realtime updates, persistence, and logs fit together.

## High-Level Runtime View

```mermaid
flowchart TB
    user["Trader / Operator"]
    frontend["Frontend React UI<br/>Execution Workspace"]
    controlPlane["Control Plane<br/>api.server:app"]
    registry["Engine Registry<br/>control_plane.db"]
    dataPlane["Dedicated Data Plane<br/>api.live_server"]
    broker["Broker APIs<br/>eToro / Angel / Fake"]
    persistence["Persistence + Logs<br/>SQLite + logs/executions"]

    user -->|"uses"| frontend
    frontend -->|"create execution"| controlPlane
    controlPlane -->|"spawn + monitor"| dataPlane
    controlPlane -->|"store engine state"| registry
    dataPlane -->|"heartbeat"| controlPlane
    frontend -->|"REST + WebSocket"| dataPlane
    dataPlane -->|"orders, positions, prices"| broker
    dataPlane -->|"events + history + logs"| persistence
    frontend -->|"registry refresh"| registry

    classDef actor fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px;
    classDef frontend fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px;
    classDef control fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:2px;
    classDef data fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;
    classDef broker fill:#ffe4e6,stroke:#e11d48,color:#881337,stroke-width:2px;
    classDef storage fill:#f3f4f6,stroke:#4b5563,color:#111827,stroke-width:2px;

    class user actor;
    class frontend frontend;
    class controlPlane,registry control;
    class dataPlane data;
    class broker broker;
    class persistence storage;
```

## Execution Creation Lifecycle

```mermaid
flowchart TB
    frontend["Frontend<br/>Create Execution Form"]
    controlApi["Control API<br/>POST /api/control/executions"]
    processManager["Engine Process Manager<br/>choose port + spawn process"]
    registryStarting["Registry Row<br/>status = starting"]
    liveServer["New Data Plane Server<br/>api.live_server"]
    heartbeat["Heartbeat<br/>pid, broker, env, executor count"]
    registryRunning["Registry Row<br/>status = running"]
    executorRegister["Register Executor<br/>POST /api/live/executors"]
    websocket["Frontend WebSocket<br/>/ws/live"]

    frontend --> controlApi
    controlApi --> processManager
    processManager --> registryStarting
    processManager --> liveServer
    liveServer --> heartbeat
    heartbeat --> registryRunning
    frontend -->|"waits until running"| registryRunning
    frontend --> executorRegister
    frontend --> websocket

    classDef frontend fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px;
    classDef control fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:2px;
    classDef data fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;
    classDef storage fill:#f3f4f6,stroke:#4b5563,color:#111827,stroke-width:2px;

    class frontend,websocket frontend;
    class controlApi,processManager control;
    class liveServer,heartbeat,executorRegister data;
    class registryStarting,registryRunning storage;
```

## Data Plane Internals

```mermaid
flowchart TB
    liveApi["Live REST API<br/>/api/live/*"]
    liveWs["Live WebSocket<br/>/ws/live"]
    strategyExecutor["Strategy Executor<br/>strategy state + signals"]
    tickProvider["Tick Provider<br/>price feed"]
    tradingManager["Trading Manager<br/>orders + positions"]
    etoro["eToro Client<br/>instrument IDs + demo/live keys"]
    angel["Angel Client<br/>symbol tokens"]
    liveEventsDb["live_events.db<br/>runtime events"]
    activityDb["order_activity.db<br/>orders, positions, history"]
    executionLog["logs/executions/name.log<br/>server output"]

    liveApi --> strategyExecutor
    tickProvider --> strategyExecutor
    strategyExecutor --> tradingManager
    tradingManager --> etoro
    tradingManager --> angel
    tickProvider --> etoro
    tickProvider --> angel
    tradingManager --> liveEventsDb
    tradingManager --> activityDb
    liveWs -->|"ticks, snapshots, order events"| liveApi
    liveApi --> executionLog

    classDef api fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;
    classDef broker fill:#ffe4e6,stroke:#e11d48,color:#881337,stroke-width:2px;
    classDef storage fill:#f3f4f6,stroke:#4b5563,color:#111827,stroke-width:2px;

    class liveApi,liveWs,strategyExecutor,tickProvider,tradingManager api;
    class etoro,angel broker;
    class liveEventsDb,activityDb,executionLog storage;
```

## Runtime Flow

1. The frontend asks the control plane to create a new execution.
2. The control plane allocates a port and starts a dedicated data-plane process.
3. The data plane heartbeats back to the control plane, which keeps `control_plane.db` up to date.
4. The frontend reads the registry, gets the data-plane REST and WebSocket URLs, and connects to that engine.
5. The data plane handles strategy execution, ticks, orders, positions, events, and broker calls.
6. eToro executions use eToro instrument IDs as the broker token; Angel executions use Angel symbol tokens.
7. Realtime data streams back over `/ws/live`, while history and current state are persisted in SQLite.
8. Each spawned execution server writes logs to `logs/executions/<execution-name>.log`.
