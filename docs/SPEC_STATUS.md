# Spec status (v0.4)

## ✅ Done
- Lane CRUD/status/events APIs
- Start-visible workflow (start thread + optional kickoff turn + lane attach)
- Persistent lane sessions (`/lanes/:id/session/start|stop|status`)
- Prompt/steer/interrupt routed through lane session
- Approval queue API (`/lanes/:id/approvals`, approve/deny)
- Webhook fanout + SSE stream
- Webhook payload envelope now includes top-level: `eventType`, `laneId`, `payload`, `subscriptionId`, `ts`
- Hooks routing fixed end-to-end (`hooks.dio.chat/oai-app-proxy` now delivers)

## ⚠️ Known gaps
- Fresh thread `session/start` can fail with `no rollout found` race
  - Mitigations: retry on resume + increased server idle timeout
  - Still intermittent for newly created threads
- Approval persistence across proxy restart not yet durable
  - approvals are in-memory only today

## Next fixes (high priority)
1. Persist approvals to `data/approvals/<laneId>.json` and restore on boot.
2. Make `start-visible` optionally open+hold a lane session immediately after kickoff.
3. Add retry/backoff on `session/start` with configurable limits and better error classification.
4. Emit explicit `lane.completed` from real turn completion path (not only debug endpoint).

## Last verification snapshot
- Webhook subscription: `wh_959f9553-99ab-4962-9241-dea37aa18100`
- Delivery: `lastError = null`
- Lane event delivery observed for `lane.session.started` and `lane.completed`.
