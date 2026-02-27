---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Coding Style & Naming Conventions

TypeScript (strict). Runtimes: Bun 1.3+, Node 23. Prettier: 2 spaces, no semicolons, double quotes, width 100. Import order: @ianvs/prettier-plugin-sort-imports + Tailwind plugin. ESLint (flat): any disallowed; unused vars warned (prefix \_ to ignore). Naming: React components PascalCase; files kebab-case (e.g., user-profile.ts); packages @repo/<name>. Comments: avoid writing inline comments everywhere, unless absolutely necessary for a todo or an important thing to take note of. Instead write tsdoc style block level comments at the method/class/function/route level. Focus on comments that provide value in regards to better type inference and clarity of usage. Using things like params/returns/etc..

Always default to useing named paramaters in functions eg myFunction({ ctx, other }) vs myFunction(ctx, other) Never use any types and always default to leveraging generics and smart types to sensure the best possible tpye inference across the project.

<!-- hack:tickets:start -->

## Tickets (git-backed)

This project uses `hack` tickets (extension: `dance.hack.tickets`).

Common commands:

- Create: `hack x tickets create --title "..." --body-stdin` (pipe long context)
- List: `hack x tickets list`
- Show: `hack x tickets show T-00001`
- Status: `hack x tickets status T-00001 in_progress`
- Sync: `hack x tickets sync`

Data lives in `.hack/tickets/` and syncs to branch `hack/tickets` by default.

<!-- hack:tickets:end -->

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**

1. **File tickets for remaining work** - Create tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Hand off** - Provide context for next session

<!-- hack:agent-docs:start -->

## hack CLI (local dev + MCP)

Use `hack` as the single interface for local dev. It manages docker compose, TLS/DNS, and logs.

Concepts:

- Project: a repo with `.hack/` config + compose file.
- Service: a docker compose service (e.g. api, web, worker).
- Instance: a running project; branch instances are separate copies started with `--branch`.

When to use a branch instance:

- You need two versions running at once (PR review, experiments, migrations).
- You want to keep a stable environment while testing another branch.
- Use `--branch <name>` on `hack up/open/logs/down` to target it.

Standard workflow:

- If `.hack/` is missing: `hack init`
- Start services: `hack up --detach`
- Check status: `hack ps` or `hack projects status`
- Open app: `hack open` (use `--json` for machine parsing)
- Stop services: `hack down`

Logs and search:

- Tail compose logs: `hack logs --pretty` or `hack logs <service>`
- Snapshot for agents: `hack logs --json --no-follow`
- Loki history: `hack logs --loki --since 2h --pretty`
- Filter Loki services: `hack logs --loki --services api,web`
- Raw LogQL: `hack logs --loki --query '{project="<name>"}'`
- Force compose logs: `hack logs --compose`
- If Loki is unavailable, start global logs: `hack global up`

Run commands inside services:

- One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)
- Example: `hack run api bun test`
- Use `--workdir <path>` to change working dir inside the container.
- Use `hack ps --json` to list services and status.

Project targeting:

- From repo root, commands use that project automatically.
- Else use `--project <name>` (registry) or `--path <repo-root>`.
- List projects: `hack projects --json`

Daemon (optional):

- Start for faster JSON status/ps: `hack daemon start`
- Check status: `hack daemon status`

Docker compose notes:

- Prefer `hack` commands; they include the right files/networks.
- Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.

Agent setup (CLI-first):

- Cursor rules: `hack setup cursor`
- Claude hooks: `hack setup claude`
- Codex skill: `hack setup codex`
- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)
- Init patterns: `hack agent patterns`
- MCP (no-shell only): `hack setup mcp`
<!-- hack:agent-docs:end -->
