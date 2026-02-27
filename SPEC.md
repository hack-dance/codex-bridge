# oai-app-proxy v0

## Purpose
Standalone local Bun service that exposes an orchestrator-agnostic control interface for Codex app-server lanes.

## v0 scope
- HTTP API for lane lifecycle (create/list/get)
- Prompt/steer/interrupt endpoint stubs
- Approval queue API (list/approve/deny)
- In-memory lane/event store
- Append-only JSONL event persistence to `./data/events/`
- Snapshot persistence to `./data/lanes/`

## Non-goals (v0)
- Real app-server process wiring
- auth/security hardening
- multi-node scheduling
- full verification runner

## API (v0)
- `GET /health`
- `GET /lanes`
- `POST /lanes`
- `GET /lanes/:laneId`
- `POST /lanes/:laneId/prompt`
- `POST /lanes/:laneId/steer`
- `POST /lanes/:laneId/interrupt`
- `GET /lanes/:laneId/events`
- `GET /lanes/:laneId/approvals`
- `POST /lanes/:laneId/approvals/:approvalId/approve`
- `POST /lanes/:laneId/approvals/:approvalId/deny`

## Lane states
`idle | starting | running | needs_approval | blocked | verifying | done | failed | interrupted`

## Persistence
- lane snapshots: `./data/lanes/<laneId>.json`
- lane event log: `./data/events/<laneId>.jsonl`

## Next step (v1)
Add real Codex app-server bridge adapter with JSON-RPC initialize/thread/turn mapping.
