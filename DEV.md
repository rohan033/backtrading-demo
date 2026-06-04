# Local development

## Prerequisites

```bash
python3 -m venv .ven
source .ven/bin/activate
pip install -r requirements.txt
cd frontend && npm install
```

Copy env files as needed (`.env`, `.live.env`, etc.).

## Commands

| What | Command | URL |
|------|---------|-----|
| **Control plane** | `./scripts/dev-cp.sh` or `make cp` | http://localhost:8000 |
| **Frontend** | `./scripts/dev-fe.sh` or `make fe` | http://localhost:3000 |
| **Both** | `./start.sh` or `make dev` | FE proxies `/api` → CP |

### Control plane only

```bash
source .ven/bin/activate
python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend only

```bash
cd frontend && npm run dev
```

The Vite dev server proxies:

- `/api`, `/ws` → control plane `:8000`
- `/api/live`, `/ws/live` → live data plane `:8080` (when a strategy runtime is running)

## Live data planes

Live runtimes are started from the UI (**Trade → Strategies → Deploy**) or via the control plane API. Each execution gets its own port (default range `9000–9999`).
