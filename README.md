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
