#!/usr/bin/env bash
# Start control plane + frontend (wrapper — prefer scripts/start-dev.sh)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/scripts/start-dev.sh"
