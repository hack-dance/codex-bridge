#!/usr/bin/env sh
set -eu

# Ensure codex is discoverable in non-login environments (hack/docker/service)
if ! command -v codex >/dev/null 2>&1; then
  if [ -x "$HOME/.local/share/mise/shims/codex" ]; then
    PATH="$HOME/.local/share/mise/shims:$PATH"
  fi
  if [ -x "$HOME/.local/bin/codex" ]; then
    PATH="$HOME/.local/bin:$PATH"
  fi
  if [ -x "/opt/homebrew/bin/codex" ]; then
    PATH="/opt/homebrew/bin:$PATH"
  fi
fi

if [ "${1:-}" = "app-server" ] && [ -n "${CODEX_APP_SERVER_WS_URL:-}" ]; then
  exec bun "/app/scripts/codex-ws-stdio.ts" "${CODEX_APP_SERVER_WS_URL}"
fi

exec codex "$@"
