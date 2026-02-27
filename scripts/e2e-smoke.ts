import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface LaneEvent {
  eventType: string;
  laneId: string;
  subscriptionId: string;
  eventKey?: string;
  payload: JsonObject;
}

interface BridgeHttpResponse<T = JsonObject> {
  ok?: boolean;
  status: number;
  payload: T;
}

const PORT_BASE = 18_500 + Math.floor(Math.random() * 500);
const E2E_DEBUG = process.env.E2E_DEBUG === "1";

function logDebug(message: string, details?: Record<string, unknown>) {
  if (!E2E_DEBUG) {
    return;
  }
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[e2e-debug] ${message}${suffix}`);
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

async function requestJson<T>(
  base: string,
  path: string,
  init: RequestInit = {}
): Promise<BridgeHttpResponse<T>> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const requestBody = typeof init.body === "string" ? init.body : undefined;
  const url = new URL(`${base}${path}`);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const [status, payload] = await new Promise<[number, string]>(
    (resolve, reject) => {
      const req = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: `${url.pathname}${url.search}`,
          method,
          headers: requestHeaders,
        },
        (res) => {
          let text = "";
          const resStatus = res.statusCode ?? 500;
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => {
            resolve([resStatus, text]);
          });
        }
      );
      req.on("error", (error) => {
        reject(error);
      });
      if (requestBody && requestBody.length > 0) {
        req.write(requestBody);
      }
      req.end();
    }
  );
  let parsedPayload = {} as T;
  try {
    parsedPayload = JSON.parse(payload) as T;
  } catch {
    parsedPayload = {} as T;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    payload: parsedPayload,
  };
}

async function requestJsonWithDebug<T>(
  label: string,
  base: string,
  path: string,
  init: RequestInit = {}
): Promise<BridgeHttpResponse<T>> {
  const method = init.method ?? "GET";
  logDebug("request:start", { label, method, path });
  try {
    const response = await requestJson<T>(base, path, init);
    logDebug("request:done", {
      label,
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) {
      logDebug("request:failed_payload", {
        label,
        payload: response.payload,
      });
    }
    return response;
  } catch (error) {
    logDebug("request:failed", {
      label,
      message: (error as Error).message,
    });
    throw new Error(`request "${label}" failed: ${(error as Error).message}`);
  }
}

async function waitForBridgeHealth(url: string, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const health = await requestJson<Record<string, unknown>>(url, "/health");
      if (health.ok) {
        return;
      }
    } catch {
      // bridge not ready yet
    }
    await wait(100);
  }
  throw new Error("bridge health check timed out");
}

async function waitForEvents(
  getter: () => Promise<string[]>,
  predicate: (events: string[]) => boolean,
  timeoutMs = 8000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await getter();
    if (predicate(events)) {
      return events;
    }
    await wait(100);
  }
  throw new Error("event wait timed out");
}

const mockCodexScript = `#!/usr/bin/env bun

import { randomUUID } from "node:crypto"

const MOCK_DEBUG = process.env.E2E_MOCK_DEBUG === "1"

function mockLog(...parts: unknown[]) {
  if (!MOCK_DEBUG) {
    return
  }
  process.stderr.write(parts.map((part) => String(part)).join(" ") + "\\n")
}

type RpcMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

let initialized = false
let threadSeq = 1
let turnSeq = 1
const threads = new Map<string, { cwd: string }>()

function response(id: number, payload: Omit<RpcMessage, "id">) {
  process.stdout.write(JSON.stringify({ id, ...payload }) + "\\n")
}

function notify(payload: Omit<RpcMessage, "id">) {
  process.stdout.write(JSON.stringify(payload) + "\\n")
}

function error(id: number, message: string) {
  response(id, { error: { code: 400, message } })
}

function writeNoRollout(id?: number) {
  if (id === undefined) {
    return
  }
  error(id, "No rollout found for thread")
}

process.stdin.setEncoding("utf8")
let buffer = ""

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8")
  const lines = buffer.split("\\n")
  buffer = lines.pop() ?? ""

  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let msg: RpcMessage
    try {
      msg = JSON.parse(line) as RpcMessage
    } catch {
      mockLog("parse_error", line)
      continue
    }
    mockLog("rx", JSON.stringify(msg))

    if (msg.method === "initialize") {
      if (!initialized) {
        initialized = true
        response(msg.id ?? 0, {
          result: {
            userAgent: "mock-codex-app-server",
          },
        })
      } else if (msg.id !== undefined) {
        error(msg.id, "Already initialized")
      }
      continue
    }

    if (msg.method === "initialized") {
      continue
    }

    if (!initialized) {
      if (msg.id !== undefined) {
        error(msg.id, "Not initialized")
      }
      continue
    }

    if (typeof msg.id !== "number") {
      continue
    }

    const params = msg.params ?? {}
    mockLog("method", msg.method, "id", msg.id, "params", JSON.stringify(params))
    switch (msg.method) {
      case "thread/start": {
        const id = "thr_" + String(threadSeq++).padStart(4, "0")
        threads.set(id, {
          cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
        })
        response(msg.id, {
          result: {
            thread: {
              id,
              source: "cli",
              cwd: threads.get(id)?.cwd,
              status: { type: "idle" },
              updatedAt: Math.floor(Date.now() / 1000),
            },
          },
        })
        notify({
          method: "thread/started",
          params: { thread: { id } },
        })
        break
      }
      case "thread/read": {
        const threadId = params.threadId
        if (typeof threadId !== "string" || !threads.has(threadId)) {
          writeNoRollout(msg.id)
          break
        }
        const thread = threads.get(threadId)!
        response(msg.id, {
          result: {
            thread: {
              id: threadId,
              source: "cli",
              cwd: thread.cwd,
              updatedAt: Math.floor(Date.now() / 1000),
            },
          },
        })
        break
      }
      case "thread/resume": {
        const threadId = params.threadId
        if (typeof threadId !== "string" || !threads.has(threadId)) {
          writeNoRollout(msg.id)
          break
        }
        response(msg.id, {
          result: {
            thread: {
              id: threadId,
              source: "cli",
              cwd: threads.get(threadId)?.cwd,
              updatedAt: Math.floor(Date.now() / 1000),
            },
          },
        })
        break
      }
      case "app/list": {
        response(msg.id, {
          result: {
            data: [
              {
                id: "app",
                name: "codex-app",
              },
            ],
          },
        })
        break
      }
      case "skills/list": {
        response(msg.id, {
          result: {
            data: [{ name: "bash" }, { name: "web" }],
          },
        })
        break
      }
      case "model/list": {
        response(msg.id, {
          result: {
            data: [
              { id: "gpt-5-codex", name: "gpt-5-codex" },
              { id: "gpt-4o-mini", name: "gpt-4o-mini" },
            ],
          },
        })
        break
      }
      case "thread/fork": {
        const threadId = params.threadId
        if (typeof threadId !== "string") {
          writeNoRollout(msg.id)
          break
        }
        if (!threads.has(threadId)) {
          threads.set(threadId, {
            cwd: process.cwd(),
          })
        }
        const id = "thr_" + String(threadSeq++).padStart(4, "0")
        threads.set(id, {
          cwd: threads.get(threadId)?.cwd ?? process.cwd(),
        })
        response(msg.id, {
          result: {
            thread: {
              id,
              source: "cli",
              cwd: threads.get(id)?.cwd,
              status: { type: "idle" },
            },
          },
        })
        break
      }
      case "thread/archive":
      case "thread/unarchive":
      case "thread/rollback":
      case "thread/compact/start": {
        const threadId = params.threadId
        if (typeof threadId !== "string") {
          writeNoRollout(msg.id)
          break
        }
        if (!threads.has(threadId)) {
          threads.set(threadId, { cwd: process.cwd() });
        }
        response(msg.id, {
          result: {
            thread: {
              id: threadId,
              source: "cli",
              cwd: threads.get(threadId)?.cwd,
              status: { type: "idle" },
            },
          },
        })
        break
      }
      case "thread/list": {
        response(msg.id, {
          result: {
            data: Array.from(threads.keys()).map((id) => ({
              id,
              source: "cli",
              cwd: threads.get(id)?.cwd,
              status: { type: "idle" },
            })),
          },
        })
        break
      }
      case "thread/loaded/list":
        response(msg.id, { result: { data: Array.from(threads.keys()) } })
        break
      case "thread/name/set":
        response(msg.id, { result: {} })
        break
      case "turn/start":
      case "turn/steer": {
        const threadId = params.threadId
        const hasThread =
          typeof threadId === "string" && threads.has(threadId)
        if (!hasThread) {
          response(msg.id, {
            error: { code: 404, message: "No rollout found for thread" },
          })
          break
        }
        const turnId = "turn_" + String(turnSeq++).padStart(4, "0")
        response(msg.id, { result: { turn: { id: turnId } } })
        notify({
          method: "turn/started",
          params: { turn: { id: turnId, threadId } },
        })
        notify({
          method: "item/completed",
          params: {
            item: {
              id: "item_" + randomUUID(),
              type: "agentMessage",
              status: "completed",
              text: "ok",
            },
          },
        })
        setTimeout(() => {
          notify({
            method: "turn/completed",
            params: {
              turn: {
                id: turnId,
              },
              status: "completed",
              summary: "Completed turn " + turnId,
            },
          })
        }, 250)
        break
      }
      case "turn/interrupt":
        response(msg.id, { result: {} })
        break
      default:
        response(msg.id, { result: {} })
        break
    }
  }
})
`;

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "codex-bridge-e2e-"));
  const codexMock = join(tmp, "codex-mock");
  await Bun.write(codexMock, mockCodexScript);
  await chmod(codexMock, 0o700);

  const serverPort = PORT_BASE + Math.floor(Math.random() * 500);
  const webhookEvents: LaneEvent[] = [];
  const webhookServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        try {
          const raw = await request.text();
          if (!raw.trim()) {
            return new Response("ok");
          }
          const body = JSON.parse(raw) as LaneEvent;
          webhookEvents.push(body as LaneEvent);
        } catch (error) {
          if (E2E_DEBUG) {
            logDebug("webhook:parse_failed", {
              message: (error as Error).message,
            });
          }
        }
      }
      return new Response("ok");
    },
  });
  const webhookPort = webhookServer.port;
  const base = `http://127.0.0.1:${serverPort}`;
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_BIN: codexMock,
    PORT: String(serverPort),
  };
  if (E2E_DEBUG) {
    bridgeEnv.E2E_MOCK_DEBUG = "1";
  } else if (process.env.E2E_MOCK_DEBUG) {
    bridgeEnv.E2E_MOCK_DEBUG = process.env.E2E_MOCK_DEBUG;
  }
  const mock = spawn("bun", ["run", "index.ts", "--port", String(serverPort)], {
    cwd: process.cwd(),
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const kill = () => {
    mock.removeAllListeners();
    mock.stdout?.removeAllListeners();
    mock.stderr?.removeAllListeners();
    mock.kill("SIGTERM");
  };

  if (E2E_DEBUG) {
    mock.on("exit", (code, signal) => {
      logDebug("bridge:exit", { code, signal });
    });
    mock.on("error", (error) => {
      logDebug("bridge:error", { message: (error as Error).message });
    });
    mock.stdout?.on("data", (chunk) => {
      logDebug("bridge:stdout", { chunk: chunk.toString().slice(0, 200) });
    });
    mock.stderr?.on("data", (chunk) => {
      logDebug("bridge:stderr", { chunk: chunk.toString().slice(0, 200) });
    });
  }

  try {
    await waitForBridgeHealth(base);

    const subRes = await requestJsonWithDebug<{ subscription: JsonObject }>(
      "register-webhook",
      base,
      "/webhooks",
      {
        method: "POST",
        body: JSON.stringify({
          url: `http://127.0.0.1:${webhookPort}/event`,
          events: [
            "lane.session.started",
            "lane.turn.completed",
            "lane.turn.completed.notification",
            "lane.completed",
            "webhook.test",
          ],
        }),
      }
    );
    assert(subRes.ok, "failed to create webhook");
    const subId = (subRes.payload.subscription as JsonObject)?.id as string;
    assert(typeof subId === "string", "webhook subscription id missing");

    const laneId = `lane-${randomUUID()}`;
    const includeKickoff =
      process.env.E2E_SKIP_KICKOFF !== "1" &&
      process.env.E2E_SKIP_KICKOFF !== "true";
    const startPayload: JsonObject = {
      laneId,
      model: "gpt-5.1-codex",
      title: "E2E lane smoke",
      preferredSurface: "any",
    };
    if (includeKickoff) {
      startPayload.kickoffPrompt = "say ok";
    }
    const startRes = await requestJsonWithDebug<{
      lane: JsonObject;
      thread?: JsonObject;
    }>("start-visible-workflow", base, "/codex/workflows/start-visible", {
      method: "POST",
      body: JSON.stringify(startPayload),
    });
    logDebug("script:checkpoint", {
      label: "start-visible-workflow-completed",
      ok: startRes.ok,
      status: startRes.status,
    });
    assert(startRes.ok, "failed to start visible workflow");

    if (process.env.E2E_PHASE === "start-only") {
      return;
    }

    const events = await requestJsonWithDebug<{
      events: Array<{
        type: string;
        payload?: {
          deferred?: boolean;
          attempts?: number;
        };
      }>;
    }>("lane-events-initial", base, `/lanes/${laneId}/events`);
    logDebug("script:checkpoint", {
      label: "lane-events-initial-completed",
      count: events.payload.events?.length ?? 0,
    });
    const eventTypes = events.payload.events?.map((event) => event.type) ?? [];
    assert(
      eventTypes.includes("lane.session.started"),
      "lane.session.started missing"
    );
    const sessionStartedEvent = events.payload.events?.find(
      (event) => event.type === "lane.session.started"
    );
    assert(
      sessionStartedEvent?.payload?.deferred !== true,
      "new start-visible thread should not be readiness deferred"
    );
    assert(
      Number(sessionStartedEvent?.payload?.attempts ?? 0) >= 1,
      "lane.session.started attempts should be present"
    );

    if (includeKickoff) {
      await waitForEvents(
        async () => {
          const response = await requestJsonWithDebug<{
            events: Array<{ type: string }>;
          }>("lane-events", base, `/lanes/${laneId}/events`);
          assert(response.ok, "failed reading lane events");
          return response.payload.events?.map((event) => event.type) ?? [];
        },
        (items) =>
          items.includes("lane.turn.completed") &&
          items.includes("lane.turn.completed.notification") &&
          items.includes("lane.completed") &&
          items.includes("lane.item.completed.notification"),
        10_000
      );
    } else {
      await waitForEvents(
        async () => {
          const response = await requestJsonWithDebug<{
            events: Array<{ type: string }>;
          }>("lane-events", base, `/lanes/${laneId}/events`);
          assert(response.ok, "failed reading lane events");
          return response.payload.events?.map((event) => event.type) ?? [];
        },
        (items) => items.includes("lane.session.started"),
        3000
      );
    }

    const active = await requestJsonWithDebug<{ threadIds: string[] }>(
      "loaded-threads",
      base,
      "/codex/threads/loaded"
    );
    const threadsRes = await requestJsonWithDebug<{ threads: JsonObject[] }>(
      "thread-list",
      base,
      "/codex/threads?limit=10"
    );
    const codexAppList = await requestJsonWithDebug<{
      result: Record<string, unknown>;
    }>("app-list", base, "/codex/app/list");
    const codexSkillList = await requestJsonWithDebug<{
      result: Record<string, unknown>;
    }>("skills-list", base, "/codex/skills/list");
    const codexModelList = await requestJsonWithDebug<{
      result: Record<string, unknown>;
    }>("model-list", base, "/codex/model/list");
    const codexRpcList = await requestJsonWithDebug<{
      result: Record<string, unknown>;
    }>("rpc-thread-list", base, "/codex/rpc", {
      method: "POST",
      body: JSON.stringify({
        method: "thread/list",
        params: { limit: 10 },
      }),
    });
    const threadId = startRes.payload.thread?.id
      ? String(startRes.payload.thread.id)
      : null;

    assert(codexAppList.ok, "failed to read app/list");
    assert(codexSkillList.ok, "failed to read skills/list");
    assert(codexModelList.ok, "failed to read model/list");
    assert(codexRpcList.ok, "failed rpc passthrough");
    assert(threadsRes.ok, "failed to read thread list");
    assert(active.ok, "failed to read loaded thread IDs");
    assert(
      Array.isArray(active.payload.threadIds),
      "loaded thread response was malformed"
    );
    assert(Array.isArray(threadsRes.payload.threads), "thread list malformed");

    if (threadId) {
      const threadForkRes = await requestJsonWithDebug<{
        thread?: JsonObject;
      }>("thread-fork", base, `/codex/threads/${threadId}/fork`, {
        method: "POST",
      });
      const [threadCompactRes, threadArchiveRes] = await Promise.all([
        requestJsonWithDebug<{ thread?: JsonObject }>(
          "thread-compact",
          base,
          `/codex/threads/${threadId}/compact/start`,
          {
            method: "POST",
          }
        ),
        requestJsonWithDebug<{ thread?: JsonObject }>(
          "thread-archive",
          base,
          `/codex/threads/${threadId}/archive`,
          {
            method: "POST",
          }
        ),
      ]);
      assert(threadForkRes.ok, "thread fork request failed");
      assert(threadCompactRes.ok, "thread compact request failed");
      assert(threadArchiveRes.ok, "thread archive request failed");
    }

    const completeEvents = webhookEvents.filter((event) =>
      [
        "lane.session.started",
        "lane.turn.completed",
        "lane.turn.completed.notification",
        "lane.completed",
        "webhook.test",
      ].includes(event.eventType)
    );
    if (includeKickoff) {
      assert(
        completeEvents.length >= 2,
        "webhook delivery for lane lifecycle was not observed"
      );
    } else {
      assert(
        completeEvents.length >= 1,
        "webhook lifecycle delivery was not observed"
      );
    }

    const webhooksRes = await requestJsonWithDebug<{
      subscriptions: JsonObject[];
    }>("list-webhooks", base, "/webhooks");
    const subscription = webhooksRes.payload.subscriptions.find(
      (entry) => entry.id === subId
    ) as JsonObject | undefined;
    assert(
      subscription !== undefined,
      "webhook subscription not found in list"
    );
    assert(
      typeof (subscription?.lastDeliveryAt ?? "") === "string",
      "webhook lastDeliveryAt not updated"
    );
    assert(
      completeEvents
        .filter((event) => event.eventType !== "webhook.test")
        .every(
          (event) =>
            typeof event.eventKey === "string" && event.eventKey.length > 0
        ),
      "webhook eventKey missing on lifecycle events"
    );

    await requestJsonWithDebug(
      "test-webhook-delivery",
      base,
      `/webhooks/${subId}/test`,
      { method: "POST" }
    );
    await wait(500);
    assert(
      webhookEvents.some((entry) => entry.eventType === "webhook.test"),
      "manual webhook test event not delivered"
    );

    const stopRes = await requestJsonWithDebug<{ stopped: boolean }>(
      "stop-session",
      base,
      `/lanes/${laneId}/session/stop`,
      {
        method: "POST",
      }
    );
    assert(stopRes.ok, "failed to stop lane session");
  } finally {
    kill();
    webhookServer.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
