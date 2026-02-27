#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8790}"
BASE="http://localhost:$PORT"

pkill -f "bun run index.ts" >/dev/null 2>&1 || true
PORT="$PORT" bun run index.ts >/tmp/oai-app-proxy.log 2>&1 &
PID=$!
trap 'kill $PID >/dev/null 2>&1 || true' EXIT
sleep 1

curl -sf "$BASE/health" | jq '.ok == true' | grep -q true

LANE=$(curl -sf -X POST "$BASE/lanes" -H 'content-type: application/json' \
  -d '{"projectId":"dogfood","repoRoot":"/tmp/dogfood","acceptanceCriteria":["it works"]}' | jq -r '.lane.laneId')

curl -sf -X POST "$BASE/lanes/$LANE/prompt" -H 'content-type: application/json' -d '{"input":"hello"}' >/dev/null

APR=$(curl -sf -X POST "$BASE/debug/request-approval" -H 'content-type: application/json' \
  -d "{\"laneId\":\"$LANE\",\"reason\":\"dogfood approval\"}" | jq -r '.approval.approvalId')

curl -sf -X POST "$BASE/lanes/$LANE/approvals/$APR/approve" >/dev/null
curl -sf -X POST "$BASE/debug/complete" -H 'content-type: application/json' -d "{\"laneId\":\"$LANE\"}" >/dev/null

STATUS=$(curl -sf "$BASE/lanes/$LANE" | jq -r '.lane.status')
[ "$STATUS" = "done" ]

EVENT_COUNT=$(curl -sf "$BASE/lanes/$LANE/events" | jq '.events | length')
[ "$EVENT_COUNT" -ge 5 ]

echo "dogfood_pass lane=$LANE events=$EVENT_COUNT status=$STATUS"
