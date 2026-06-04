# Codebase architecture

Visual and structural reference for the backtrading monorepo (Python backend + React frontend).

## Index

| Doc | Contents |
|-----|----------|
| [01-system-context.md](01-system-context.md) | Runtime processes, `make dev`, deploy flow |
| [02-layers-and-modules.md](02-layers-and-modules.md) | L0–L5 layers, package map |
| [03-domain-models.md](03-domain-models.md) | Dataclasses, protocols, strategies |
| [04-live-engine.md](04-live-engine.md) | Data plane class graph and tick flow |
| [05-control-plane.md](05-control-plane.md) | Control plane services and API models |
| [06-brokers.md](06-brokers.md) | Angel, eToro, fake broker subsystem |
| [07-events-and-telegram.md](07-events-and-telegram.md) | Events, notifications, EventBus |
| [08-agent-mcp.md](08-agent-mcp.md) | Cursor agent, FastMCP, skills |
| [09-frontend-api.md](09-frontend-api.md) | Vite proxy and HTTP/WS contract |
| [10-legacy-and-package.md](10-legacy-and-package.md) | Legacy roots, `src/backtrading/` index |
| [11-claude-suggestions-reconciliation.md](11-claude-suggestions-reconciliation.md) | External Claude refactor ideas vs this repo |

Related: [../ARCHITECTURE.md](../ARCHITECTURE.md) (migration overview), [../docs/event-bus.md](../docs/event-bus.md).
