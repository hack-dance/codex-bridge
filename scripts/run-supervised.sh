#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/dev/scratch/oai-app-proxy"
export PORT=8787
export CODEX_BIN="/Users/hack/.local/share/mise/installs/node/24.11.0/bin/codex"
export PATH="/Users/hack/.local/share/mise/installs/node/24.11.0/bin:/Users/hack/.local/share/mise/installs/bun/1.3.9/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
while true; do
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] starting oai-app-proxy" >> /tmp/oai-app-proxy-supervisor.log
  /Users/hack/.local/share/mise/installs/bun/1.3.9/bin/bun index.ts >> /tmp/oai-app-proxy.log 2>&1 || true
  rc=$?
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] oai-app-proxy exited rc=$rc; restarting in 1s" >> /tmp/oai-app-proxy-supervisor.log
  sleep 1
done
