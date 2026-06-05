#!/usr/bin/env bash
# Start frontend (Vite) on http://localhost:3000 — proxies /api and /ws to control plane :8000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/frontend"

if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies..."
  npm install
fi

echo "Frontend → http://localhost:3000"
echo "API proxy → http://localhost:8000 (start control plane separately or via ./start.sh)"
exec npm run dev
