# Spec status (v0.5.1)

## ✅ Done
- Lane CRUD/status/events APIs
- Start-visible workflow (start thread + optional kickoff turn + lane attach)
- Persistent lane sessions (`/lanes/:id/session/start|stop|status`)
- Prompt/steer/interrupt routed through lane session
- Approval queue API (`/lanes/:id/approvals`, approve/deny)
- Webhook fanout + SSE stream
- Webhook payload envelope now includes top-level: `eventType`, `laneId`, `payload`, `subscriptionId`, `ts`
- Hooks routing fixed end-to-end (`hooks.dio.chat/oai-app-proxy` now delivers)
- Added `/codex/threads/loaded` passthrough for `thread/loaded/list`
- Added explicit thread action endpoints for `fork`, `archive`, `unarchive`, `rollback`, `compact/start` (+ `compact` alias)
- Added list endpoints for `app/list`, `skills/list`, and `model/list`
- Added `/codex/workflows/start-visible` one-shot start/takeover flow with surface constraints
- Added readiness gate with bounded retry/backoff for `thread/read` + `thread/resume`
- Added per-lane readiness mode (`lenient` default, optional `strict`)
- Added canonical completion signal `lane.turn.completed` while keeping raw `lane.turn.completed.notification`
- Added webhook dedupe metadata fields: `eventKey` and `eventId`
- Added graceful session stop behavior (best-effort `turn/interrupt` before process shutdown)
- Added deterministic bridge e2e smoke coverage (`bun run smoke:e2e` in CI/test flow)
- New-thread start-visible path now follows same-session app-server flow (no new-thread resume/readiness polling race)
- Added retry-with-backoff for lane turn `start|steer|interrupt` on `no rollout found`
- Added watcher hardening: no overlapping ticks, per-tick thread lookup cache, synthetic-thread skip, terminal missing-thread blocking
- Added stale state reconciliation endpoint: `POST /debug/reconcile-stale`

## ⚠️ Known gaps
- Approval persistence across proxy restart not yet durable
  - approvals are in-memory only today
- `GET /codex/running` is macOS-specific process detection
  - tuned for Desktop app process command path and local `lsof`
- Surface preference is advisory for discovery/start
  - takeover can enforce surface match, but brand-new `thread/start` surface is decided by Codex runtime

## Next fixes (high priority)
1. Persist approvals to `data/approvals/<laneId>.json` and restore on boot.
2. Expand process/session detection portability beyond macOS Desktop app process signatures.
3. Add contract tests for explicit approval request/response cycle from app-server notifications.

## Last verification snapshot
- Verification: `bun x ultracite check`, `bun run typecheck`, `bun test`, `bun run smoke:e2e`
