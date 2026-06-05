#!/usr/bin/env bash
# Start control plane (FastAPI) on http://localhost:8000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -d ".ven/bin" ]]; then
  # shellcheck disable=SC1091
  source .ven/bin/activate
elif [[ -d ".venv/bin" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
elif [[ -d "venv/bin" ]]; then
  # shellcheck disable=SC1091
  source venv/bin/activate
else
  echo "No virtualenv found (.ven, .venv, or venv). Create one and pip install -r requirements.txt"
  exit 1
fi

export PYTHONUNBUFFERED=1

RELOAD=0
if [[ "${DEV_RELOAD:-}" == "1" ]] || [[ "${1:-}" == "--reload" ]]; then
  RELOAD=1
fi

echo "Control plane → http://localhost:8000"
if [[ "$RELOAD" == "1" ]]; then
  echo "Auto-reload: on (watches source files; can be CPU-heavy with logs/DB churn)"
  exec python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload
fi

echo "Auto-reload: off (use make dev-reload or ./scripts/dev-cp.sh --reload to enable)"
exec python -m uvicorn api.server:app --host 0.0.0.0 --port 8000
