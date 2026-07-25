#!/usr/bin/env bash
# Start control plane (FastAPI) on http://127.0.0.1:8000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/ensure-venv.sh"

export PYTHONUNBUFFERED=1

RELOAD=0
if [[ "${DEV_RELOAD:-}" == "1" ]] || [[ "${1:-}" == "--reload" ]]; then
  RELOAD=1
fi

echo "Control plane → http://127.0.0.1:8000"
UVICORN_LOG_CONFIG="$(python -c "from control_plane.ops_logging import write_uvicorn_log_config; print(write_uvicorn_log_config())")"
if [[ "$RELOAD" == "1" ]]; then
  echo "Auto-reload: on (watches source files; can be CPU-heavy with logs/DB churn)"
  exec python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload --log-config "$UVICORN_LOG_CONFIG"
fi

echo "Auto-reload: off (use make dev-reload or ./scripts/dev-cp.sh --reload to enable)"
exec python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --log-config "$UVICORN_LOG_CONFIG"
