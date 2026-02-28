#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "app-server" ] && [ -n "${CODEX_APP_SERVER_WS_URL:-}" ]; then
  exec bun "/app/scripts/codex-ws-stdio.ts" "${CODEX_APP_SERVER_WS_URL}"
fi

exec codex "$@"
