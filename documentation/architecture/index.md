# Codebase architecture

Visual and structural reference for the backtrading monorepo (Python backend + React frontend).

## Index

| Doc | Contents |
|-----|----------|
| [System context](01-system-context.md) | Runtime processes, `make dev`, deploy flow |
| [Layers and modules](02-layers-and-modules.md) | L0–L5 layers, package map |
| [Domain models](03-domain-models.md) | Dataclasses, protocols, strategies |
| [Live engine](04-live-engine.md) | Data plane class graph and tick flow |
| [Control plane](05-control-plane.md) | Control plane services and API models |
| [Brokers](06-brokers.md) | Angel, eToro, fake broker subsystem |
| [Events and Telegram](07-events-and-telegram.md) | Events, notifications, EventBus |
| [Agent and MCP](08-agent-mcp.md) | Cursor agent, FastMCP, skills |
| [Frontend API](09-frontend-api.md) | Vite proxy and HTTP/WS contract |
| [Legacy and package](10-legacy-and-package.md) | Legacy roots, `src/backtrading/` index |
| [Claude suggestions](11-claude-suggestions-reconciliation.md) | External refactor ideas vs this repo |

Related: [Migration overview](../migration-overview.md) · [Event bus](../guides/event-bus.md).

Repo copies of these pages also live under [`architecture/`](https://github.com/rohan033/backtrading-demo/tree/main/architecture) in the repository.
