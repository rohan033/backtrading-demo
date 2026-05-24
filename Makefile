.PHONY: cp fe dev install-fe

# Control plane (FastAPI) — http://localhost:8000
cp:
	./scripts/dev-cp.sh

# Frontend (Vite) — http://localhost:3000
fe:
	./scripts/dev-fe.sh

# Both servers
dev:
	./scripts/start-dev.sh

# One-time frontend deps
install-fe:
	cd frontend && npm install
