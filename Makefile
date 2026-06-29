.PHONY: cp cp-reload fe dev dev-reload install-fe install-backend docs docs-build install-docs

# Editable install of src/backtrading (optional; dev scripts also add src/ to PYTHONPATH)
install-backend:
	pip install -e .

# Control plane (FastAPI) — http://127.0.0.1:8000
cp:
	./scripts/dev-cp.sh

cp-reload:
	./scripts/dev-cp.sh --reload

# Frontend (Vite) — http://127.0.0.1:3000
fe:
	./scripts/dev-fe.sh

# Both servers (creates .venv on first run if missing)
dev:
	./scripts/start-dev.sh

# Both servers with control-plane auto-reload
dev-reload:
	./scripts/start-dev.sh --reload

# One-time frontend deps
install-fe:
	cd frontend && npm install

# MkDocs (Material) — http://127.0.0.1:8001
install-docs:
	pip install -e ".[docs]"

docs:
	mkdocs serve -a 127.0.0.1:8001

docs-build:
	mkdocs build
