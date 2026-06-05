#!/usr/bin/env bash
# Start control plane + frontend for local development

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CP_PID=""
FE_PID=""

cleanup() {
  echo ""
  echo "Stopping servers..."
  [[ -n "$CP_PID" ]] && kill "$CP_PID" 2>/dev/null || true
  [[ -n "$FE_PID" ]] && kill "$FE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Done."
  exit 0
}

trap cleanup INT TERM EXIT

CP_RELOAD=0
if [[ "${1:-}" == "--reload" ]]; then
  CP_RELOAD=1
  echo "Control plane auto-reload: on"
fi

echo "Starting control plane..."
if [[ "$CP_RELOAD" == "1" ]]; then
  "$ROOT/scripts/dev-cp.sh" --reload &
else
  "$ROOT/scripts/dev-cp.sh" &
fi
CP_PID=$!

echo "Waiting for control plane..."
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8000/docs >/dev/null 2>&1 || curl -sf http://localhost:8000/api/control/engines >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Starting frontend..."
"$ROOT/scripts/dev-fe.sh" &
FE_PID=$!

echo ""
echo "Control plane: http://localhost:8000"
echo "Frontend:      http://localhost:3000"
echo "Press Ctrl+C to stop both."
echo ""

wait
