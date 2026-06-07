#!/usr/bin/env bash
# Symlink packaged skills into .cursor/skills for IDE discovery (optional).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/backtrading/agentic/skills"
DEST="$ROOT/.cursor/skills"
mkdir -p "$DEST"
for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  target="$DEST/$name"
  rm -f "$target"
  ln -sf "../../src/backtrading/agentic/skills/$name" "$target"
  echo "Linked $target"
done
