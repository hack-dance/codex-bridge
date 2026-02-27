# Session and Takeover Runbook

This runbook explains how to run Codex threads through `codex-bridge`, including:
- starting new managed threads,
- taking over existing Desktop/CLI/VS Code threads,
- safely handing control between clients (desktop, phone, remote agent),
- routing approvals and webhooks without polling loops.

## Terms

- lane: Bridge-owned orchestration record keyed by `laneId`.
- thread: Codex conversation/thread ID.
- lane session: Persistent `codex app-server` process bound to one lane.
- surface: Normalized source type: `mac-app`, `cli`, `vscode`, `unknown`.
- readiness mode:
  - `lenient` (default): allows deferred readiness if resume is not immediately available.
  - `strict`: requires successful readiness resume before continuing.

## Mental model

- One active lane session should control one lane at a time.
- Lane session state is long-lived and streams notifications from app-server.
- Thread turn operations for an attached lane should go through lane endpoints (`/lanes/:laneId/:action`), not one-shot RPC.
- Webhooks and SSE are downstream consumers of lane events.

## A) Start a brand-new managed thread

Use when no existing thread should be reused.

```bash
curl -s -X POST http://127.0.0.1:8787/codex/workflows/start-visible \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-new",
    "title":"New managed thread",
    "kickoffPrompt":"Start work on issue T-123",
    "preferredSurface":"any",
    "requirePreferredSurface":false,
    "readinessMode":"lenient"
  }' | jq
```

Workflow:
1. lane is created.
2. lane session is started (`initialize` + `initialized`).
3. `thread/start` runs inside that session.
4. for brand-new threads, kickoff uses the same live session directly (no cross-session resume polling).
   for takeover flows, readiness gate retries `thread/read` and `thread/resume` (bounded backoff).
5. optional kickoff `turn/start` runs.
6. lane status moves to `running`.

## B) Take over existing Desktop App thread (recommended for live handoff)

### 1) Find active desktop threads

```bash
curl -s 'http://127.0.0.1:8787/codex/active?windowSec=3600&preferredSurface=mac-app&preferOriginator=Codex%20Desktop' | jq
```

Notes:
- `preferredSurface` narrows if matches exist.
- `preferOriginator` biases results if matches exist.
- If no preferred matches exist, endpoint falls back to full active list.

### 2) Attach lane to thread ID

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/attach \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-desktop",
    "threadId":"<thread-id>",
    "preferredSurface":"mac-app",
    "requirePreferredSurface":true,
    "readinessMode":"strict"
  }' | jq
```

### 3) Start lane session

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/session/start | jq
```

## C) One-shot takeover (single endpoint)

If you already have a `threadId` and want attach + session bootstrap in one call:

```bash
curl -s -X POST http://127.0.0.1:8787/codex/workflows/start-visible \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-takeover",
    "threadId":"<thread-id>",
    "preferredSurface":"any",
    "requirePreferredSurface":false,
    "readinessMode":"lenient"
  }' | jq
```

## D) Hand off between clients (desktop -> phone -> desktop)

Use the same `laneId` from each client:

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/prompt \
  -H 'content-type: application/json' \
  -d '{"input":"Continue and post progress"}' | jq
```

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/steer \
  -H 'content-type: application/json' \
  -d '{"input":"Focus only on failing tests"}' | jq
```

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/interrupt \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

The lane session remains server-side; clients can come and go.

## Approvals

List approvals:

```bash
curl -s http://127.0.0.1:8787/lanes/lane-desktop/approvals | jq
```

Approve:

```bash
curl -s -X POST \
  http://127.0.0.1:8787/lanes/lane-desktop/approvals/<approval-id>/approve | jq
```

Deny:

```bash
curl -s -X POST \
  http://127.0.0.1:8787/lanes/lane-desktop/approvals/<approval-id>/deny | jq
```

## Event + webhook contract

Watch SSE:

```bash
curl -N http://127.0.0.1:8787/events/stream
```

Create webhook:

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://example.com/hook",
    "events":["lane.session.started","lane.completed","lane.approval.requested"],
    "enabled":true
  }' | jq
```

Webhook payload top-level fields:
- `eventType`
- `eventKey` (stable dedupe key for consumers)
- `eventId`
- `laneId`
- `payload`
- `subscriptionId`
- `ts`

Completion event semantics:
- Canonical turn completion: `lane.turn.completed`
- Raw forwarded app-server notification: `lane.turn.completed.notification`
- Workflow completion: `lane.completed`
- Kickoff skip signal when takeover readiness is deferred: `lane.turn.skipped.readiness_deferred`

## Surface constraints and guarantees

Guaranteed:
- You can take over any known thread by ID.
- You can require surface match on takeover (`requirePreferredSurface=true`).
- You can filter and prefer surfaces when discovering active threads.

Not guaranteed:
- A brand-new `thread/start` cannot be forced onto a specific surface by bridge configuration; Codex determines thread source/surface.

## Troubleshooting

### `no rollout found` during readiness

Bridge behavior:
- readiness gate retries with bounded backoff,
- in `lenient` mode takeover flows can be recorded as deferred readiness and still emit lane session started.
- in `strict` mode, readiness failures block start/turn actions.

Check:
- `GET /lanes/:laneId/events`
- `GET /lanes/:laneId/session/status`

### New threads not obvious in Desktop or old threads look stuck

Check:
- Ensure `repoRoot` is passed during start/takeover so thread `cwd` maps to the Desktop workspace you are viewing.
- Inspect `GET /lanes/:laneId/session/status`:
  - `readinessDeferred=true` means session is alive but resume was not confirmed yet.
  - `readinessReason` contains the latest readiness failure reason.
- Stop lingering sessions with `POST /lanes/:laneId/session/stop`.
  - bridge now sends best-effort `turn/interrupt` before process shutdown to reduce “thinking forever” stuck states.
- Reconcile stale bridge state if you ran many local test lanes:
  - `POST /debug/reconcile-stale` (blocks synthetic `thr_*` running lanes and clears orphaned `activeTurnId` values).

### Lane exists / thread not found / surface mismatch

Common responses:
- `409 lane_exists`
- `404 thread_not_found`
- `409 surface_mismatch`

## Verification checklist

```bash
bun x ultracite check
bun run typecheck
bun test
bun run smoke:e2e
```

Expected e2e milestones:
- `lane.session.started`
- `lane.turn.completed`
- `lane.completed`
