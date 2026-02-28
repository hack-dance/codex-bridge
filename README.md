# codex-bridge

Reliable bridge service for Codex thread orchestration, lane/session lifecycle management, and event/webhook fanout.

`codex-bridge` runs a Bun + Elysia HTTP service (`oai-app-proxy`) that:

- tracks lanes and persistent lane sessions
- creates/takes over Codex threads
- drives turns (`start`, `steer`, `interrupt`)
- emits structured lane events to SSE and webhooks
- handles approval workflows
- exposes OpenAPI docs for the full API surface

---

## Table of Contents

- [Core Concepts](#core-concepts)
- [Quickstart](#quickstart)
- [Runtime + Integration Notes](#runtime--integration-notes)
- [API Overview](#api-overview)
- [Schema Reference](#schema-reference)
- [Endpoint Reference](#endpoint-reference)
- [Webhook Guide (Global, Single-Target, Multi-Target)](#webhook-guide-global-single-target-multi-target)
- [Common Operator Flows](#common-operator-flows)
- [Dashboard HUD](#dashboard-hud)
- [Verification](#verification)
- [Repo Layout](#repo-layout)

---

## Core Concepts

### Thread

A Codex conversation context returned by Codex APIs (`thread/*`). Threads have metadata like:

- `id`
- `title`
- `cwd`
- `source` / `sourceKind`
- `updatedAt`

Threads can have lineage (parent/child) through sub-agent spawn sources.

### Lane

A bridge-managed control plane record for a unit of work. Lanes optionally attach to a Codex thread and track:

- lifecycle status (`idle`, `starting`, `running`, `needs_approval`, `blocked`, `verifying`, `done`, `failed`, `interrupted`)
- workspace context (`projectId`, `repoRoot`, `branch`, `worktreePath`)
- runtime intent (`acceptanceCriteria`, `verificationCommands`)
- session behavior (`readinessMode`)

### Lane Session

A persistent app-server process channel used for thread-turn operations on a lane.

- one active session per lane
- supports structured request/response and notification handling
- session state includes readiness deferral fields used in takeover scenarios

### Approval

A lane-scoped approval request emitted during guarded workflows.

- requested via runtime/app-server path
- resolved with `approve` or `deny`
- can be bridged back to app-server request IDs when session is active

### Webhook Subscription

A destination + event matcher + optional scope filter for outbound event delivery.

Supports hybrid targeting:

- global (no scope set)
- lane-scoped (`laneId` / `laneIds`)
- thread-scoped (`threadId` / `threadIds`)
- session-scoped (`sessionId` / `sessionIds`)
- combined scope (AND semantics across dimensions)

---

## Quickstart

### Local (direct)

```bash
bun install
PORT=8787 bun run index.ts
```

Health check:

```bash
curl -s http://127.0.0.1:8787/health | jq
```

OpenAPI:

```bash
open http://127.0.0.1:8787/openapi
```

### With `hack` (recommended in this repo)

```bash
hack up
hack status
hack logs app
```

Teardown:

```bash
hack down
```

---

## Runtime + Integration Notes

- Transport is HTTP for bridge API, with lane sessions backed by Codex app-server RPC.
- Service version and app-server wiring are visible in `GET /health`.
- In containerized environments, `GET /codex/running` falls back to inferred sessions from recent thread activity when host process inspection cannot see host PIDs.

---

## API Overview

- Base URL: `http://127.0.0.1:8787` (local) or your `hack` host
- Content type: `application/json`
- Auth: none by default (assume trusted internal network or front with auth proxy)
- Validation errors: HTTP `400` with `validation_error`
- Not found: HTTP `404` with route-specific error code (e.g. `lane_not_found`)

Live stream:

- `GET /events/stream` returns SSE events for lane event feed consumers

---

## Schema Reference

Exact machine-readable schemas are always in OpenAPI:

- `GET /openapi`
- `GET /openapi/json`

The following are operator-focused summaries.

### Lane (summary)

```json
{
  "laneId": "lane-uuid-or-custom",
  "projectId": "optional-project",
  "repoRoot": "/abs/path",
  "threadId": "optional-thread-id",
  "status": "running",
  "activeTurnId": "optional-turn-id",
  "readinessMode": "strict|lenient",
  "preferredSurface": "mac-app|vscode|cli|any",
  "surface": "mac-app|vscode|cli|unknown",
  "acceptanceCriteria": ["..."],
  "verificationCommands": ["..."],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### Lane Session Status (summary)

```json
{
  "running": true,
  "threadId": "thread-id-or-null",
  "startedAt": "ISO-8601|null",
  "pendingRequests": 0,
  "activeTurnId": "turn-id-or-null",
  "readinessMode": "strict|lenient",
  "readinessDeferred": false,
  "readinessReason": null
}
```

### Approval (summary)

```json
{
  "approvalId": "apr_...",
  "laneId": "lane-...",
  "source": "app-server|runtime",
  "reason": "string",
  "status": "pending|approved|denied",
  "createdAt": "ISO-8601",
  "resolvedAt": "ISO-8601|null"
}
```

### Webhook Subscription (summary)

```json
{
  "id": "wh_...",
  "url": "https://destination.example/webhook",
  "events": ["lane.completed", "lane.approval.requested", "*"],
  "enabled": true,
  "scope": {
    "laneIds": ["lane-a", "lane-b"],
    "threadIds": ["thread-x"],
    "sessionIds": ["lane-a"]
  },
  "scopeKinds": ["lane", "thread", "session"],
  "secret": "optional-shared-secret",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastDeliveryAt": "ISO-8601|null",
  "lastError": "optional-last-error"
}
```

### Lane Event + Webhook Envelope

Bridge emits lane events internally, then fans matching events to webhooks:

```json
{
  "id": "delivery-id",
  "ts": "ISO-8601",
  "source": "oai-app-proxy",
  "eventKey": "subscriptionId:eventId",
  "eventId": "lane-event-id",
  "subscriptionId": "wh_...",
  "eventType": "lane.completed",
  "laneId": "lane-...",
  "threadId": "thread-...|null",
  "sessionId": "lane-...|null",
  "scope": { "laneIds": [], "threadIds": [], "sessionIds": [] },
  "payload": {},
  "event": {}
}
```

---

## Endpoint Reference

All endpoints below are available via OpenAPI tags (`health`, `watch`, `webhooks`, `codex`, `lanes`, `approvals`, `debug`).

## Health + Stream

- `GET /health`
  - returns service/runtime status including codex binary/app-server metadata
- `GET /events/stream`
  - SSE stream of lane events

## Watch

- `GET /watch/status`
  - returns watcher state
- `POST /watch/start`
  - body:
    ```json
    { "intervalSec": 15 }
    ```
- `POST /watch/stop`
- `POST /watch/tick`

## Webhooks

- `GET /webhooks`
  - list subscriptions
- `POST /webhooks`
  - create subscription
  - body:
    ```json
    {
      "url": "https://example.com/hook",
      "events": ["lane.completed", "lane.failed"],
      "enabled": true,
      "secret": "optional-secret",
      "scope": {
        "laneId": "lane-1",
        "laneIds": ["lane-1", "lane-2"],
        "threadId": "thread-1",
        "threadIds": ["thread-1", "thread-2"],
        "sessionId": "lane-1",
        "sessionIds": ["lane-1", "lane-2"]
      }
    }
    ```
- `PATCH /webhooks/{id}`
  - partial update of `url`, `events`, `enabled`, `secret`, `scope`
- `DELETE /webhooks/{id}`
- `POST /webhooks/{id}/test`
  - emits `webhook.test` through normal dispatch path

## Codex

- `POST /codex/rpc`
  - raw passthrough to any Codex RPC method
  - body:
    ```json
    { "method": "thread/list", "params": {} }
    ```
- `GET /codex/app/list`
- `GET /codex/skills/list`
- `GET /codex/model/list`

Threads:

- `GET /codex/threads`
  - query:
    - `limit` (default 50, max 200)
    - `sourceKinds` (CSV)
- `GET /codex/threads/{threadId}`
- `GET /codex/threads/loaded`
- `POST /codex/threads/start`
  - body:
    ```json
    { "model": "optional-model-id" }
    ```

Thread actions:

- `POST /codex/threads/{threadId}/fork`
- `POST /codex/threads/{threadId}/archive`
- `POST /codex/threads/{threadId}/unarchive`
- `POST /codex/threads/{threadId}/rollback`
- `POST /codex/threads/{threadId}/compact/start`
- `POST /codex/threads/{threadId}/compact` (alias)

Each action accepts optional passthrough body:

```json
{ "anyCodexActionOptions": "..." }
```

Turn control:

- `POST /codex/threads/{threadId}/turns/{action}`
  - `action`: `start | steer | interrupt`
  - body:
    ```json
    {
      "input": "required for start/steer",
      "turnId": "optional for interrupt",
      "expectedTurnId": "optional optimistic concurrency for steer/start"
    }
    ```

Visibility + activity:

- `GET /codex/active`
  - query:
    - `windowSec`
    - `source`
    - `sourceKinds` (CSV)
    - `surface`
    - `originator`
    - `preferOriginator`
    - `preferredSurface`
- `GET /codex/running`
  - process detection + fallback thread inference mode metadata

Workflow:

- `POST /codex/workflows/start-visible`
  - creates or takes over a lane + session + thread flow
  - body:
    ```json
    {
      "laneId": "optional custom lane id",
      "projectId": "optional project id",
      "repoRoot": "/abs/path",
      "title": "optional lane/thread title",
      "kickoffPrompt": "optional first instruction",
      "threadId": "optional takeover thread id",
      "preferredSurface": "mac-app|vscode|cli|any",
      "requirePreferredSurface": false,
      "readinessMode": "strict|lenient",
      "model": "optional model id",
      "acceptanceCriteria": ["..."],
      "verificationCommands": ["..."]
    }
    ```

## Lanes + Approvals

Lane CRUD:

- `GET /lanes`
- `POST /lanes`
  - body:
    ```json
    {
      "laneId": "optional",
      "projectId": "optional",
      "repoRoot": "optional",
      "threadId": "optional",
      "readinessMode": "strict|lenient",
      "acceptanceCriteria": ["..."],
      "verificationCommands": ["..."]
    }
    ```
- `GET /lanes/{laneId}`
- `DELETE /lanes/{laneId}`

Attach + sync:

- `POST /lanes/attach`
  - attach existing thread to new lane
  - body includes:
    - required: `threadId`
    - optional: `laneId`, `projectId`, `repoRoot`, `preferredSurface`, `requirePreferredSurface`, `readinessMode`, `acceptanceCriteria`, `verificationCommands`
- `POST /lanes/{laneId}/sync-from-codex`
  - refreshes lane metadata from attached thread

Session lifecycle:

- `GET /lanes/sessions` (all lane session snapshots)
- `GET /lanes/{laneId}/session/status`
- `POST /lanes/{laneId}/session/start`
- `POST /lanes/{laneId}/session/stop`

Lane turn actions:

- `POST /lanes/{laneId}/{action}`
  - `action`: `prompt | steer | interrupt`
  - body:
    ```json
    { "input": "required for prompt/steer" }
    ```

Lane events:

- `GET /lanes/{laneId}/events`

Maintenance:

- `POST /lanes/cleanup`
  - bulk lane cleanup with filters
  - body:
    ```json
    {
      "statuses": ["blocked", "done", "failed", "interrupted"],
      "olderThanHours": 24,
      "syntheticOnly": false,
      "limit": 100,
      "dryRun": true
    }
    ```

Approvals:

- `GET /lanes/{laneId}/approvals`
- `POST /lanes/{laneId}/approvals/{approvalId}/{action}`
  - `action`: `approve | deny`

## Debug

- `POST /debug/request-approval`
  - body:
    ```json
    {
      "laneId": "lane-id",
      "source": "app-server|runtime",
      "reason": "optional reason"
    }
    ```
- `POST /debug/complete`
  - body:
    ```json
    { "laneId": "lane-id", "note": "optional debug note" }
    ```
- `POST /debug/reconcile-stale`
  - body:
    ```json
    {
      "clearSyntheticRunningLanes": true,
      "clearOrphanedActiveTurns": true
    }
    ```

---

## Webhook Guide (Global, Single-Target, Multi-Target)

Event matching is:

1. subscription is enabled
2. event type matches one of `events` patterns (supports `*`)
3. scope matches lane/thread/session context (if scope is present)

Scope dimensions are ANDed when multiple are set:

- `laneIds` must include event lane
- `threadIds` must include event thread
- `sessionIds` must include event session

### 1) Global subscription (everything)

Use for global observability and warehouse ingestion.

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://ops.example/global",
    "events":["*"],
    "enabled":true
  }' | jq
```

### 2) Single lane target

Use when one external worker owns one lane.

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://worker.example/lane-123",
    "events":["lane.completed","lane.approval.requested"],
    "scope":{"laneId":"lane-123"}
  }' | jq
```

### 3) Multi lane targets

Use for queue fan-in patterns.

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://worker.example/multi",
    "events":["lane.*"],
    "scope":{"laneIds":["lane-a","lane-b","lane-c"]}
  }' | jq
```

### 4) Thread-scoped subscription

Use when thread identity is the durable owner key.

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://worker.example/thread-owner",
    "events":["lane.turn.completed","lane.completed"],
    "scope":{"threadId":"thread_abc"}
  }' | jq
```

### 5) Hybrid scope (lane + thread + session)

Use when you need strict narrowing.

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://worker.example/hybrid",
    "events":["lane.turn.completed"],
    "scope":{
      "laneIds":["lane-xyz"],
      "threadIds":["thread-xyz"],
      "sessionIds":["lane-xyz"]
    }
  }' | jq
```

### Choosing scope style

- **Global**: monitoring, analytics, general event bus
- **Lane single/multi**: task orchestration and worker ownership
- **Thread scope**: conversation-centric ownership
- **Session scope**: transient runtime-specific listeners
- **Hybrid**: strict routing for high-signal, low-noise automation

---

## Common Operator Flows

### Start new managed lane + thread

```bash
curl -s -X POST http://127.0.0.1:8787/codex/workflows/start-visible \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-new",
    "title":"Bridge managed lane",
    "kickoffPrompt":"Review current branch and summarize status",
    "preferredSurface":"any",
    "requirePreferredSurface":false,
    "readinessMode":"lenient"
  }' | jq
```

### Take over existing thread

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/attach \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-takeover",
    "threadId":"<thread-id>",
    "preferredSurface":"any",
    "requirePreferredSurface":false,
    "readinessMode":"strict"
  }' | jq
```

Start lane session:

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-takeover/session/start | jq
```

### Drive lane work

```bash
# prompt
curl -s -X POST http://127.0.0.1:8787/lanes/lane-takeover/prompt \
  -H 'content-type: application/json' \
  -d '{"input":"continue execution"}' | jq

# steer active turn
curl -s -X POST http://127.0.0.1:8787/lanes/lane-takeover/steer \
  -H 'content-type: application/json' \
  -d '{"input":"narrow to failing tests"}' | jq

# interrupt active turn
curl -s -X POST http://127.0.0.1:8787/lanes/lane-takeover/interrupt \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

### Cleanup stale lanes

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/cleanup \
  -H 'content-type: application/json' \
  -d '{
    "statuses":["blocked","done","failed","interrupted"],
    "olderThanHours":12,
    "syntheticOnly":false,
    "limit":250,
    "dryRun":false
  }' | jq
```

---

## Dashboard HUD

The Next.js dashboard (`dashboard/`) includes:

- `Overview` - top-level operational signal and action shortcuts
- `Lanes` - lane inventory + controls
- `Threads` - thread lineage table
- `Webhooks` - scoped subscription visibility
- `Topology` - React Flow graph (threads ↔ lanes ↔ sessions with detail drawer)
- `System` - runtime metadata and health diagnostics

Run dashboard:

```bash
bun run dev:dashboard
```

---

## Verification

```bash
bun x ultracite check
bun run typecheck
bun test
bun run smoke:e2e
```

Dashboard quality gate:

```bash
bun run --cwd dashboard build
bun run --cwd dashboard lint
```

---

## Repo Layout

- `index.ts` - bootstrap entrypoint (`initializeBridgeRuntime` + Elysia listen)
- `src/app.ts` - app composition + OpenAPI plugin
- `src/modules/bridge/service.ts` - stateful runtime/session orchestration
- `src/modules/*/index.ts` - API route modules
- `dashboard/` - operational HUD app
- `schema/` - protocol and schema assets
- `docs/` - runbooks and spec docs
- `scripts/` - utilities and diagnostics
- `data/` - local runtime persistence (gitignored)

# codex-bridge

Bridge service for reliable, async orchestration of Codex threads and lanes.

`codex-bridge` runs a Bun + Elysia HTTP service (`oai-app-proxy`) that:
- tracks lane lifecycle and persistent app-server sessions,
- attaches/starts/steers/interrupts Codex threads,
- emits SSE + webhook events for wake-driven orchestration,
- handles approval requests and completion payloads,
- exposes typed OpenAPI docs.

## Session model

For lane control-plane operations, the bridge uses one persistent app-server process per active lane:
- initialize once per lane session,
- keep thread/turn operations on that same live session,
- route app-server notifications into lane events and webhook fanout.

Session-oriented endpoints:
- `POST /lanes/:laneId/session/start`
- `POST /lanes/:laneId/session/stop`
- `GET /lanes/:laneId/session/status`
- `POST /lanes/:laneId/:action` (`prompt`, `steer`, `interrupt`)
- `POST /codex/workflows/start-visible` (one-shot start/takeover workflow)

Per-lane readiness policy:
- `readinessMode: "lenient"` (default) allows deferred readiness (`no rollout found`) for takeover flows.
- `readinessMode: "strict"` blocks/fails takeover start and turn actions until resume readiness is confirmed.
- New thread creation (`thread/start` on the same lane session) now uses the app-server happy path directly and does not run cross-session resume polling.

## Surface model (Desktop vs CLI vs VS Code)

Surfaces are normalized to: `mac-app`, `cli`, `vscode`, `unknown`.

What you can do today:
- Prefer or filter by surface when discovering threads (`GET /codex/active`).
- Enforce surface compatibility when taking over an existing thread (`requirePreferredSurface`).
- Take over any known thread regardless of origin (`/lanes/attach` or `/codex/workflows/start-visible` with `threadId`).

What you cannot force today:
- Bridge cannot force a brand-new `thread/start` to be born on a specific surface. Source/surface are determined by Codex runtime behavior.

## Quickstart

```bash
bun install
PORT=8787 bun run index.ts
```

```bash
curl -s http://127.0.0.1:8787/health | jq
```

OpenAPI docs:
- `GET /openapi`

## Common operator flows

### 1) Start a new managed lane + thread

```bash
curl -s -X POST http://127.0.0.1:8787/codex/workflows/start-visible \
  -H 'content-type: application/json' \
  -d '{
    "laneId":"lane-new",
    "title":"Bridge managed lane",
    "kickoffPrompt":"Review current branch and summarize status",
    "preferredSurface":"any",
    "requirePreferredSurface":false,
    "readinessMode":"lenient"
  }' | jq
```

This performs:
- lane create,
- persistent lane session start,
- `thread/start`,
- same-session workflow bootstrap (no cross-session resume poll for new thread),
- optional kickoff `turn/start`,
- lane status -> `running`.

### 2) Take over an existing Desktop App thread

Discover likely desktop-active threads:

```bash
curl -s 'http://127.0.0.1:8787/codex/active?windowSec=3600&preferredSurface=mac-app&preferOriginator=Codex%20Desktop' | jq
```

Attach lane:

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

Start persistent session for that lane:

```bash
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/session/start | jq
```

### 3) One-shot takeover (attach + session) for an existing thread

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

### 4) Drive turns remotely (desktop <-> phone handoff pattern)

Use the same lane ID from any client:

```bash
# prompt
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/prompt \
  -H 'content-type: application/json' \
  -d '{"input":"Continue from latest plan and execute tests"}' | jq

# steer active turn
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/steer \
  -H 'content-type: application/json' \
  -d '{"input":"Narrow scope to lint/type errors first"}' | jq

# interrupt active turn
curl -s -X POST http://127.0.0.1:8787/lanes/lane-desktop/interrupt \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

## Events, approvals, and webhooks

Key lane lifecycle events:
- `lane.session.started`
- `lane.turn.skipped.readiness_deferred` (kickoff intentionally skipped when takeover readiness is deferred)
- `lane.turn.started.notification`
- `lane.item.completed.notification`
- `lane.turn.completed` (canonical completion signal for consumers)
- `lane.turn.completed.notification`
  - raw forwarded app-server notification (`turn/completed`)
- `lane.completed`
- `lane.approval.requested`
- `lane.approval.resolved`

Webhook envelope includes top-level:
- `eventType`
- `eventKey` (stable dedupe key per subscription + event)
- `eventId` (lane event id)
- `laneId`
- `payload`
- `subscriptionId`
- `ts`

Example webhook setup:

```bash
curl -s -X POST http://127.0.0.1:8787/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://example.com/hook",
    "events":["lane.session.started","lane.completed","lane.approval.requested"],
    "enabled":true
  }' | jq
```

Approvals API:
- `GET /lanes/:laneId/approvals`
- `POST /lanes/:laneId/approvals/:approvalId/approve`
- `POST /lanes/:laneId/approvals/:approvalId/deny`

## Desktop visibility and stuck-thread notes

If new bridge-started threads are not obvious in Desktop, or older ones look stuck:
- pass explicit `repoRoot` (maps to thread `cwd`) so the thread is created in the workspace you are viewing,
- prefer `readinessMode: "strict"` for takeover lanes that must be fully resumable,
- check `GET /lanes/:laneId/session/status` for `readinessDeferred` and `readinessReason`,
- call `POST /lanes/:laneId/session/stop` to gracefully interrupt active turns before shutdown (bridge now sends `turn/interrupt` on stop when possible).
- run stale reconciliation to clear synthetic test lanes and orphaned active turn pointers:
  - `POST /debug/reconcile-stale`

```bash
curl -s -X POST http://127.0.0.1:8787/debug/reconcile-stale \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

## Verification

```bash
bun x ultracite check
bun run typecheck
bun test
bun run smoke:e2e
```

`smoke:e2e` validates:
- start-visible workflow and lane session lifecycle,
- webhook delivery and `lastDeliveryAt` updates,
- session stop path.

## Additional docs

- [Session + Takeover Runbook](docs/SESSION_RUNBOOK.md)
- [Spec status](docs/SPEC_STATUS.md)

## Hack CLI integration

After `hack init`, run with:

```bash
hack up
hack logs codex-bridge
hack down
```

## Repo layout

- `index.ts` - bootstrap entrypoint (runtime init + Elysia listen)
- `src/app.ts` - app composition + OpenAPI plugin
- `src/modules/bridge/service.ts` - stateful runtime/session orchestration logic
- `src/modules/*/index.ts` - feature route modules (`health`, `watch`, `webhooks`, `codex`, `lanes`, `debug`)
- `schema/` - protocol schemas
- `docs/` - specs and runbooks
- `scripts/` - utility and verification scripts
- `data/` - runtime persistence (gitignored)
