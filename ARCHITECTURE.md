# Architecture

Layered Python backend (`src/backtrading/`) with stable HTTP/WS contracts for the React frontend.

## Dev runtime

| Command | Backend | Port |
|---------|---------|------|
| `make dev` | `uvicorn api.server:app` (control plane) | 8000 |
| `make fe` | Vite frontend | 3000 |
| Deploy strategy | `python -m api.live_server` (data plane) | 9000–9999 |

See [DEV.md](DEV.md) and [docs/ui-smoke.md](docs/ui-smoke.md).

## Layers (L0–L5)

- **L0–L1:** `core_trading/models`, `brokers/protocols`
- **L2:** `brokers/*`, `persistence`, `observability`
- **L3:** `orchestration/{engines,scheduling,research}`, `agentic`, `mcps`
- **L4:** `telegram`, `cursor`
- **L5:** `apps/control_plane`, `apps/live_engine`, `commands`

## Current vs target mapping

| Current | Target |
|---------|--------|
| `api/server.py` | `apps/control_plane` + route modules |
| `api/live_server.py` | `apps/live_engine` |
| `control_plane/` | `orchestration/` (engines, scheduling, research) |
| `strategies/`, `managers/`, `indicators/` | `core_trading/` |
| `event/telegram_*` | `telegram/` |
| `event/event_manager.py` | `core_trading/events/` |
| `api/control_plane_mcp*.py` | `mcps/` |

Legacy import paths remain via shims during migration.

## Docs

- **[architecture/](architecture/)** — diagrams, class maps, module index (start here for deep dives)
- [docs/event-bus.md](docs/event-bus.md)
- [docs/observability.md](docs/observability.md)
- [docs/fake-broker.md](docs/fake-broker.md)
- [docs/ui-smoke.md](docs/ui-smoke.md)
