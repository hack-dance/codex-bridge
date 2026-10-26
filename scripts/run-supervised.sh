#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/dev/scratch/oai-app-proxy"
export PORT=8787
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$CODEX_BIN" || -z "$BUN_BIN" ]]; then
  echo "run-supervised: codex and bun must be on PATH (or set CODEX_BIN / BUN_BIN)" >&2
  exit 1
fi
export CODEX_BIN
while true; do
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] starting oai-app-proxy" >> /tmp/oai-app-proxy-supervisor.log
  "$BUN_BIN" index.ts >> /tmp/oai-app-proxy.log 2>&1 || true
  rc=$?
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] oai-app-proxy exited rc=$rc; restarting in 1s" >> /tmp/oai-app-proxy-supervisor.log
  sleep 1
done
