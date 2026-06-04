# Backtrading (monorepo)

Control plane + live trading engine + React frontend for strategy deployment and monitoring.

## Quickstart

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install -e .   # optional: installs src/backtrading package

# Control plane + frontend
make dev
```

- Control plane: http://localhost:8000 (OpenAPI `/docs`)
- Frontend: http://localhost:3000

Copy [`env.example`](env.example) to `.env` and broker env files as needed.

## Live engine (fake broker, no credentials)

```bash
python -m api.live_server --fake --port 9090 --engine-id local-test
```

See [docs/fake-broker.md](docs/fake-broker.md).

## Documentation

Browse locally with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/):

```bash
pip install -e ".[docs]"
make docs          # http://127.0.0.1:8001
make docs-build    # static site in site/
```

Source lives in [`documentation/`](documentation/) (wrappers) and reuses [`architecture/`](architecture/), [`docs/`](docs/), and [`ARCHITECTURE.md`](ARCHITECTURE.md).

### GitHub Pages

Published at **https://rohan033.github.io/backtrading-demo/** when you push to `main` (or `master`).

1. In the repo on GitHub: **Settings → Pages → Build and deployment → Source** → choose **GitHub Actions**.
2. Merge/push changes; the [docs workflow](.github/workflows/docs.yml) runs `mkdocs build` and deploys `site/`.
3. Optional: **Actions → docs → Run workflow** to redeploy without a doc commit.

Uses a **project site** URL (`username.github.io/repo-name/`). `site_url` in `mkdocs.yml` must match that path so search and assets resolve correctly.

## Architecture (repo markdown)

- [architecture/](architecture/) — system diagrams, classes, modules, API map
- [ARCHITECTURE.md](ARCHITECTURE.md) — migration overview and layer rules

## Optional features

| Feature | Env / extra |
|---------|-------------|
| Angel One | `pip install -e ".[angel]"` + Angel credentials |
| eToro | `.demo.env` / `.live.env` |
| Strategy AI (Cursor) | `.cursor-api.env` from `.cursor-api.env.example` |
| Telegram | `.telegram.env` |

## CLI

```bash
python -m backtrading control-plane
python -m backtrading live-engine --fake
```

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## Manual verification

[docs/ui-smoke.md](docs/ui-smoke.md)
