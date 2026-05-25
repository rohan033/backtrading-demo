.PHONY: cp cp-reload fe dev dev-reload install-fe

# Control plane (FastAPI) — http://localhost:8000
cp:
	./scripts/dev-cp.sh

cp-reload:
	./scripts/dev-cp.sh --reload

# Frontend (Vite) — http://localhost:3000
fe:
	./scripts/dev-fe.sh

# Both servers (no uvicorn --reload; lighter on CPU)
dev:
	./scripts/start-dev.sh

# Both servers with control-plane auto-reload
dev-reload:
	./scripts/start-dev.sh --reload

# One-time frontend deps
install-fe:
	cd frontend && npm install
