# codex-bridge

Bridge service for reliable, async orchestration of Codex threads and lanes.

This project runs a Bun HTTP service (`oai-app-proxy`) that:
- tracks lane lifecycle + persistent sessions,
- attaches/starts/steers/interrupts Codex threads,
- emits SSE + webhook events for wake-driven orchestration,
- handles approvals and completion payloads (including changed files).

## Why this exists

We want deterministic orchestration from Dio/code-orchestrator:
1. start/attach lane,
2. start persistent session,
3. submit prompts / steer turns,
4. receive wakeups via webhooks,
5. route approvals/completions without polling loops.

## Current status

- Service version: `v0.4`
- Core endpoints: `/health`, `/lanes/*`, `/codex/*`, `/webhooks/*`, `/events/stream`, `/watch/*`
- Webhook contract includes top-level envelope fields: `eventType`, `laneId`, `payload`, `subscriptionId`, `ts`.

## Local run

```bash
bun install
PORT=8787 bun run index.ts
```

Health check:

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Example flow

```bash
# 1) discover active threads
curl -s 'http://127.0.0.1:8787/codex/active?windowSec=1800&preferredSurface=any' | jq

# 2) attach lane to existing thread
curl -s -X POST http://127.0.0.1:8787/lanes/attach \
  -H 'content-type: application/json' \
  -d '{"laneId":"lane-demo","threadId":"<thread-id>","preferredSurface":"any","requirePreferredSurface":false}' | jq

# 3) start lane session
curl -s -X POST http://127.0.0.1:8787/lanes/lane-demo/session/start | jq
```

## Hack CLI integration

After `hack init`, run with:

```bash
hack up
hack logs codex-bridge
hack down
```

## Repo layout

- `index.ts` — main Bun server + lane/session/webhook logic
- `schema/` — protocol schemas
- `docs/` — specs/runbooks
- `scripts/` — utility/supervisor scripts
- `data/` — runtime persistence (gitignored)

## Safety + ops notes

- Keep webhook targets authenticated and minimal.
- Prefer fail-closed behavior when bridge preflight is unhealthy.
- Avoid direct fallback execution paths for orchestrated tickets.
