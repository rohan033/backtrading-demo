# Quickstart

## Prerequisites

- Python 3.11+
- Node.js (for frontend)

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e ".[docs]"   # optional: MkDocs site
cd frontend && npm install
```

## Environment

Copy templates and fill in only what you need:

```bash
cp env.example .env
# Optional: .cursor-api.env, .telegram.env, brokers/etoro .demo.env / .live.env
```

See [Environment setup](guides/env-setup.md).

## Run locally

```bash
make dev
```

- Control plane API + OpenAPI: http://localhost:8000/docs
- UI: http://localhost:3000

Control plane only:

```bash
make cp
```

## Live engine without credentials

```bash
python -m api.live_server --fake --port 9090 --engine-id local-test
```

Details: [Fake broker](guides/fake-broker.md).

## Documentation site

```bash
make docs
# open http://127.0.0.1:8001
```

Build static HTML:

```bash
make docs-build
# output in site/
```

## CLI helpers

```bash
python -m backtrading control-plane
python -m backtrading live-engine --fake
```
