#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_PORT="${ZEROCLAW_GATEWAY_PORT:-42617}"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "SafeSpend refused to start a duplicate ZeroClaw daemon: port $GATEWAY_PORT is already listening." >&2
  echo "Check the existing runtime with: curl -sS http://127.0.0.1:$GATEWAY_PORT/health" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec zeroclaw --config-dir "$PROJECT_ROOT/.zeroclaw-dev" daemon
