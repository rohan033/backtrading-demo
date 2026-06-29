#!/usr/bin/env bash
# Start frontend (Vite) on http://localhost:3000 — proxies /api and /ws to control plane :8000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/frontend"

if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies..."
  npm install
fi

echo "Frontend → http://127.0.0.1:3000"
echo "API proxy → http://127.0.0.1:8000 (start control plane separately or via make dev)"
exec npm run dev
