#!/usr/bin/env bash
# Ensure a Python virtualenv exists and is activated (default: .venv).
# Intended to be sourced: source scripts/ensure-venv.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${VENV_DIR:-.venv}"

cd "$ROOT"

ensure_venv() {
  if [[ -n "${VIRTUAL_ENV:-}" ]] && [[ -x "${VIRTUAL_ENV}/bin/python" ]]; then
    return 0
  fi

  for candidate in "$VENV_DIR" .venv .ven venv; do
    if [[ -d "$candidate/bin" ]]; then
      # shellcheck disable=SC1091
      source "$candidate/bin/activate"
      return 0
    fi
  done

  echo "Creating Python virtualenv in ${VENV_DIR}..."
  python3 -m venv "$VENV_DIR"
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"

  echo "Installing Python dependencies..."
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  pip install -e .
}

ensure_venv
