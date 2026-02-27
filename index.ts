import { mkdir, appendFile, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

type LaneStatus =
  | "idle"
  | "starting"
  | "running"
  | "needs_approval"
  | "blocked"
  | "verifying"
  | "done"
  | "failed"
  | "interrupted";

type Lane = {
  laneId: string;
  projectId?: string;
  repoRoot?: string;
  nodeId?: string;
  worktreePath?: string;
  branch?: string;
  threadId?: string;
  activeTurnId?: string;
  preferredSurface?: "mac-app" | "vscode" | "cli" | "any";
  surface?: "mac-app" | "vscode" | "cli" | "unknown";
  status: LaneStatus;
  acceptanceCriteria: string[];
  verificationCommands: string[];
  createdAt: string;
  updatedAt: string;
};

type LaneEvent = {
  eventId: string;
  laneId: string;
  type: string;
  ts: string;
  severity: "info" | "warn" | "error";
  payload?: Record<string, unknown>;
};

type Approval = {
  approvalId: string;
  laneId: string;
  source: "app-server" | "runtime";
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt?: string;
  rpcRequestId?: number;
  rpcMethod?: string;
  rpcParams?: Record<string, unknown>;
};

type CodexThread = {
  id: string;
  preview?: string;
  cwd?: string;
  source?: string;
  updatedAt?: number;
  path?: string;
  surface?: "mac-app" | "vscode" | "cli" | "unknown";
  originator?: string | null;
  title?: string | null;
  pinned?: boolean;
  desktopLikely?: boolean;
};


type WebhookSubscription = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt?: string;
  lastError?: string;
};


type LaneSession = {
  laneId: string;
  threadId: string;
  proc: ReturnType<typeof spawn>;
  rl: readline.Interface;
  seq: number;
  pending: Map<number, (msg: any) => void>;
  serverRequests: Map<number, { method: string; params: Record<string, unknown> }>;
  startedAt: string;
};

const lanes = new Map<string, Lane>();
const laneEvents = new Map<string, LaneEvent[]>();
const approvals = new Map<string, Approval[]>();
const attachedThreadLastUpdated = new Map<string, number>();
const webhookSubscriptions = new Map<string, WebhookSubscription>();
const laneSessions = new Map<string, LaneSession>();

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const dataRoot = join(process.cwd(), "data");
const laneDir = join(dataRoot, "lanes");
const eventDir = join(dataRoot, "events");
const webhookFile = join(dataRoot, "webhooks.json");

await mkdir(laneDir, { recursive: true });
await mkdir(eventDir, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function normalizeSurface(source?: unknown): "mac-app" | "vscode" | "cli" | "unknown" {
  if (typeof source !== "string") return "unknown";
  const s = source.toLowerCase();
  if (s === "vscode") return "vscode";
  if (s === "cli") return "cli";
  if (s === "app" || s === "desktop" || s === "mac-app" || s === "codex-app") return "mac-app";
  return "unknown";
}


type GlobalCodexState = {
  titles: Record<string, string>;
  pinned: Set<string>;
  activeRoots: string[];
};

async function readCodexGlobalState(): Promise<GlobalCodexState> {
  const home = process.env.HOME ?? "";
  const out: GlobalCodexState = { titles: {}, pinned: new Set<string>(), activeRoots: [] };
  if (!home) return out;
  try {
    const raw = await readFile(join(home, ".codex", ".codex-global-state.json"), "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const tt = (j["thread-titles"] ?? {}) as Record<string, unknown>;
    const titles = (tt["titles"] ?? {}) as Record<string, unknown>;
    out.titles = Object.fromEntries(Object.entries(titles).filter(([,v]) => typeof v === "string")) as Record<string,string>;
    const pinned = (j["pinned-thread-ids"] ?? []) as unknown[];
    out.pinned = new Set<string>(pinned.filter((x): x is string => typeof x === "string"));
    const roots = (j["active-workspace-roots"] ?? []) as unknown[];
    out.activeRoots = roots.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore
  }
  return out;
}

async function readOriginatorFromRollout(pathVal?: string): Promise<string | null> {
  if (!pathVal) return null;
  try {
    const raw = await Bun.file(pathVal).slice(0, 8192).text();
    const first = raw.split("\n")[0] ?? "";
    if (!first.trim()) return null;
    const obj = JSON.parse(first) as Record<string, unknown>;
    const payload = (obj["payload"] ?? obj) as Record<string, unknown>;
    const originator = payload["originator"];
    return typeof originator === "string" ? originator : null;
  } catch {
    return null;
  }
}

async function enrichCodexThread(t: CodexThread, state?: GlobalCodexState): Promise<CodexThread> {
  const g = state ?? (await readCodexGlobalState());
  const originator = await readOriginatorFromRollout(t.path);
  const title = g.titles[t.id] ?? null;
  const pinned = g.pinned.has(t.id);
  const desktopLikely = originator === "Codex Desktop" || (t.source === "vscode" && !!t.cwd && g.activeRoots.some((r) => t.cwd?.startsWith(r)));
  return {
    ...t,
    originator,
    title,
    pinned,
    desktopLikely,
  };
}

const encoder = new TextEncoder();
function sseBroadcast(type: string, payload: unknown) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const bytes = encoder.encode(frame);
  for (const c of sseClients) {
    try {
      c.enqueue(bytes);
    } catch {
      sseClients.delete(c);
    }
  }
}

async function persistLane(lane: Lane) {
  await writeFile(join(laneDir, `${lane.laneId}.json`), JSON.stringify(lane, null, 2));
}

async function emitEvent(event: LaneEvent) {
  const events = laneEvents.get(event.laneId) ?? [];
  events.push(event);
  laneEvents.set(event.laneId, events);
  await appendFile(join(eventDir, `${event.laneId}.jsonl`), `${JSON.stringify(event)}\n`);
  sseBroadcast("lane_event", event);
  await dispatchWebhooks(event);
}

async function setLaneStatus(lane: Lane, status: LaneStatus, type: string, payload?: Record<string, unknown>) {
  lane.status = status;
  lane.updatedAt = nowIso();
  await persistLane(lane);
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type,
    ts: nowIso(),
    severity: "info",
    payload,
  });
}

function getLaneOr404(laneId: string) {
  return lanes.get(laneId) ?? null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function parseBody(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}


function eventMatches(pattern: string, eventType: string) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return eventType.startsWith(pattern.slice(0, -1));
  }
  return pattern === eventType;
}

async function persistWebhooks() {
  const list = [...webhookSubscriptions.values()];
  await writeFile(webhookFile, JSON.stringify({ subscriptions: list }, null, 2));
}

async function dispatchWebhooks(event: LaneEvent) {
  const subs = [...webhookSubscriptions.values()].filter(
    (w) => w.enabled && w.events.some((e) => eventMatches(e, event.type)),
  );
  if (!subs.length) return;

  await Promise.allSettled(
    subs.map(async (sub) => {
      const payload = {
        id: randomUUID(),
        ts: nowIso(),
        source: "oai-app-proxy",
        subscriptionId: sub.id,
        eventType: event.type,
        laneId: event.laneId,
        payload: event.payload ?? {},
        event,
      };

      try {
        const res = await fetch(sub.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(sub.secret ? { "x-oai-app-proxy-secret": sub.secret } : {}),
          },
          body: JSON.stringify(payload),
        });
        sub.lastDeliveryAt = nowIso();
        sub.lastError = res.ok ? undefined : `http_${res.status}`;
      } catch (err) {
        sub.lastError = (err as Error).message;
      }
      sub.updatedAt = nowIso();
    }),
  );

  await persistWebhooks();
}


async function startLaneSession(lane: Lane) {
  if (!lane.threadId) throw new Error("lane has no threadId");
  const existing = laneSessions.get(lane.laneId);
  if (existing) return existing;

  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: proc.stdout });
  const session: LaneSession = {
    laneId: lane.laneId,
    threadId: lane.threadId,
    proc,
    rl,
    seq: 1,
    pending: new Map(),
    serverRequests: new Map(),
    startedAt: nowIso(),
  };

  const send = (payload: any) => proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method: string, params: Record<string, unknown>) => {
    const id = session.seq++;
    send({ id, method, params });
    return new Promise<any>((resolve, reject) => {
      session.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${method}`)), 15000);
    });
  };

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && !msg.method) {
        const cb = session.pending.get(msg.id);
        if (cb) {
          session.pending.delete(msg.id);
          cb(msg);
        }
        return;
      }

      if (typeof msg.id === "number" && msg.method) {
        session.serverRequests.set(msg.id, { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
        if (String(msg.method).includes("requestApproval")) {
          const approval: Approval = {
            approvalId: `apr_${randomUUID()}`,
            laneId: lane.laneId,
            source: "app-server",
            reason: String(msg.method),
            status: "pending",
            createdAt: nowIso(),
            rpcRequestId: msg.id,
            rpcMethod: String(msg.method),
            rpcParams: (msg.params ?? {}) as Record<string, unknown>,
          };
          const list = approvals.get(lane.laneId) ?? [];
          list.push(approval);
          approvals.set(lane.laneId, list);
          void setLaneStatus(lane, "needs_approval", "lane.approval.requested", {
            approvalId: approval.approvalId,
            reason: approval.reason,
            rpcRequestId: approval.rpcRequestId ?? null,
            rpcMethod: approval.rpcMethod ?? null,
            rpcParams: approval.rpcParams ?? {},
          });
        }
        return;
      }

      if (msg?.method === "turn/started" && msg?.params?.turn?.id) {
        lane.activeTurnId = String(msg.params.turn.id);
        lane.updatedAt = nowIso();
        void persistLane(lane);
        void emitEvent({
          eventId: randomUUID(),
          laneId: lane.laneId,
          type: "lane.turn.started.notification",
          ts: nowIso(),
          severity: "info",
          payload: { turnId: lane.activeTurnId, threadId: lane.threadId },
        });
      }
      if (msg?.method === "turn/completed") {
        lane.updatedAt = nowIso();
        lane.activeTurnId = undefined;
        void persistLane(lane);
        void emitLaneCompletion(lane, (msg?.params ?? {}) as Record<string, unknown>);
      }
    } catch {
      // ignore parse errors
    }
  });

  const init = await request("initialize", { clientInfo: { name: "oai_app_proxy", title: "oai-app-proxy", version: "0.4.0" } });
  if (init?.error) throw new Error(init.error?.message ?? "initialize failed");
  send({ method: "initialized", params: {} });

  let resumed: any = null;
  let lastResumeErr: string | null = null;
  for (let i = 0; i < 8; i++) {
    resumed = await request("thread/resume", { threadId: lane.threadId });
    if (!resumed?.error) break;
    lastResumeErr = String(resumed.error?.message ?? "thread/resume failed");
    if (!lastResumeErr.toLowerCase().includes("no rollout found")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (resumed?.error) throw new Error(lastResumeErr ?? "thread/resume failed");

  laneSessions.set(lane.laneId, session);
  await emitEvent({ eventId: randomUUID(), laneId: lane.laneId, type: "lane.session.started", ts: nowIso(), severity: "info", payload: { threadId: lane.threadId } });
  return session;
}

async function stopLaneSession(laneId: string) {
  const s = laneSessions.get(laneId);
  if (!s) return false;
  try { s.proc.kill("SIGTERM"); } catch {}
  try { s.rl.close(); } catch {}
  laneSessions.delete(laneId);
  return true;
}

async function laneSessionRequest(laneId: string, method: string, params: Record<string, unknown>) {
  const s = laneSessions.get(laneId);
  if (!s) throw new Error("lane session not running");
  const id = s.seq++;
  if (!s.proc.stdin) throw new Error("lane session stdin unavailable");
  s.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return await new Promise<any>((resolve, reject) => {
    s.pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout:${method}`)), 15000);
  });
}

async function laneSessionRespondApproval(laneId: string, requestId: number, decision: "approved" | "denied") {
  const s = laneSessions.get(laneId);
  if (!s) throw new Error("lane session not running");
  if (!s.serverRequests.has(requestId)) throw new Error("approval request not found in session");
  if (!s.proc.stdin) throw new Error("lane session stdin unavailable");
  s.proc.stdin.write(`${JSON.stringify({ id: requestId, result: { decision } })}\n`);
  s.serverRequests.delete(requestId);
}


async function collectChangedFiles(repoRoot?: string): Promise<string[]> {
  if (!repoRoot) return [];
  try {
    const out = await Bun.$`git -C ${repoRoot} status --porcelain`.text();
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^..\s+/, ""));
  } catch {
    return [];
  }
}

function extractCompletionText(params: Record<string, unknown>): string | null {
  const candidates = [
    params?.summary,
    params?.message,
    params?.output,
    (params as any)?.result,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 2000);
  }
  return null;
}

async function emitLaneCompletion(lane: Lane, params: Record<string, unknown> = {}, note?: string) {
  const changedFiles = await collectChangedFiles(lane.repoRoot);
  const completionText = extractCompletionText(params);
  const completionPayload: Record<string, unknown> = {
    threadId: lane.threadId ?? null,
    repoRoot: lane.repoRoot ?? null,
    changedFiles,
    completionText,
    params,
    note: note ?? null,
  };

  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: "lane.turn.completed.notification",
    ts: nowIso(),
    severity: "info",
    payload: completionPayload,
  });
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: "lane.completed",
    ts: nowIso(),
    severity: "info",
    payload: completionPayload,
  });
}

async function restoreFromDisk() {
  const laneFiles = await readdir(laneDir).catch(() => [] as string[]);
  for (const file of laneFiles) {
    if (!file.endsWith(".json")) continue;
    const text = await readFile(join(laneDir, file), "utf8");
    const lane = JSON.parse(text) as Lane;
    lanes.set(lane.laneId, lane);
    if (!approvals.has(lane.laneId)) approvals.set(lane.laneId, []);
  }

  const eventFiles = await readdir(eventDir).catch(() => [] as string[]);
  for (const file of eventFiles) {
    if (!file.endsWith(".jsonl")) continue;
    const laneId = file.replace(/\.jsonl$/, "");
    const text = await readFile(join(eventDir, file), "utf8");
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LaneEvent);
    laneEvents.set(laneId, events);
  }

  const webhookText = await readFile(webhookFile, "utf8").catch(() => "");
  if (webhookText) {
    try {
      const parsed = JSON.parse(webhookText) as { subscriptions?: WebhookSubscription[] };
      for (const sub of parsed.subscriptions ?? []) webhookSubscriptions.set(sub.id, sub);
    } catch {
      // ignore invalid webhook file
    }
  }
}

async function codexRpc(method: string, params: Record<string, unknown> = {}) {
  const codexBin = process.env.CODEX_BIN || "codex";
  const proc = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: proc.stdout });

  let seq = 1;
  const pending = new Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const settleAll = (err: Error) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(id);
    }
  };

  proc.on("error", (err) => {
    settleAll(new Error(`codex_spawn_failed:${(err as Error).message}`));
  });

  const send = (payload: any) => {
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      throw new Error(`codex_stdin_failed:${(err as Error).message}`);
    }
  };

  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    const out = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout:${m}`));
      }, 7000);
      pending.set(id, { resolve, reject, timer });
    });
    send({ id, method: m, params: p });
    return out;
  };

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    } catch {
      // ignore parse noise
    }
  });

  const hardTimer = setTimeout(() => {
    const err = new Error(`timeout:${method}:hard`);
    settleAll(err);
    try { proc.kill("SIGKILL"); } catch {}
  }, 12000);

  try {
    const init = await request("initialize", {
      clientInfo: { name: "oai_app_proxy", title: "oai-app-proxy", version: "0.4.0" },
    });
    if (init?.error) throw new Error(init.error?.message ?? "initialize failed");
    send({ method: "initialized", params: {} });

    const res = await request(method, params);
    if (res?.error) throw new Error(res.error?.message ?? `${method} failed`);
    return res?.result ?? {};
  } catch (error) {
    settleAll(error as Error);
    throw error;
  } finally {
    clearTimeout(hardTimer);
    try { rl.close(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
  }
}

async function listCodexThreads(limit = 50, sourceKinds?: string[]): Promise<CodexThread[]> {
  const params: Record<string, unknown> = { limit };
  if (sourceKinds && sourceKinds.length) params.sourceKinds = sourceKinds;
  const result = await codexRpc("thread/list", params);
  const data = (result?.data ?? []) as CodexThread[];
  const state = await readCodexGlobalState();
  const base = data.map((t) => ({ ...t, surface: normalizeSurface(t.source) }));
  return await Promise.all(base.map((t) => enrichCodexThread(t, state)));
}

async function getCodexThreadById(threadId: string): Promise<CodexThread | null> {
  try {
    const res = await codexRpc("thread/read", { threadId });
    if (res?.thread?.id) return await enrichCodexThread({ ...(res.thread as CodexThread), surface: normalizeSurface((res.thread as CodexThread).source) });
  } catch {
    // fallback below
  }
  const threads = await listCodexThreads(300, ["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]);
  return threads.find((t) => t.id === threadId) ?? null;
}


async function codexThreadStart(params: Record<string, unknown> = {}) {
  const res = await codexRpc("thread/start", params);
  const t = (res?.thread ?? null) as CodexThread | null;
  return t ? await enrichCodexThread({ ...t, surface: normalizeSurface(t.source) }) : null;
}

async function codexThreadSetName(threadId: string, name: string) {
  await codexRpc("thread/name/set", { threadId, name });
}


async function codexStartThreadWithOptionalTurn(opts: { model?: string; cwd?: string; kickoffPrompt?: string }) {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: proc.stdout });
  let seq = 1;
  const pending = new Map<number, (msg: any) => void>();
  const notes: any[] = [];
  const send = (payload: any) => proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    send({ id, method: m, params: p });
    return new Promise<any>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${m}`)), 12000);
    });
  };
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && !msg.method) {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      } else {
        notes.push(msg);
      }
    } catch {}
  });

  try {
    const init = await request("initialize", { clientInfo: { name: "oai_app_proxy", title: "oai-app-proxy", version: "0.4.0" } });
    if (init?.error) throw new Error(init.error?.message ?? "initialize failed");
    send({ method: "initialized", params: {} });

    const st = await request("thread/start", { model: opts.model, cwd: opts.cwd });
    if (st?.error || !st?.result?.thread?.id) throw new Error(st?.error?.message ?? "thread/start failed");
    const thread = { ...(st.result.thread as CodexThread), surface: normalizeSurface((st.result.thread as CodexThread).source) };

    let turnId: string | null = null;
    if (opts.kickoffPrompt) {
      const tr = await request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: opts.kickoffPrompt }],
      });
      if (tr?.error) throw new Error(tr.error?.message ?? "turn/start failed");
      turnId = (tr?.result?.turn?.id as string | undefined) ?? null;
    }

    proc.kill("SIGTERM");
    return { thread, turnId, notifications: notes.slice(0, 50) };
  } catch (error) {
    proc.kill("SIGTERM");
    throw error;
  }
}

async function codexTurnOnThread(threadId: string, inputText: string, mode: "start" | "steer" = "start", expectedTurnId?: string) {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: proc.stdout });

  let seq = 1;
  const pending = new Map<number, (msg: any) => void>();
  const notes: any[] = [];

  const send = (payload: any) => proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    send({ id, method: m, params: p });
    return new Promise<any>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${m}`)), 12000);
    });
  };

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && !msg.method) {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      } else {
        notes.push(msg);
      }
    } catch {
      // ignore parse noise
    }
  });

  try {
    const init = await request("initialize", {
      clientInfo: { name: "oai_app_proxy", title: "oai-app-proxy", version: "0.4.0" },
    });
    if (init?.error) throw new Error(init.error?.message ?? "initialize failed");
    send({ method: "initialized", params: {} });

    const resume = await request("thread/resume", { threadId });
    if (resume?.error) throw new Error(resume.error?.message ?? "thread/resume failed");

    const method = mode === "steer" ? "turn/steer" : "turn/start";
    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: inputText }],
    };
    if (mode === "steer" && expectedTurnId) turnParams.expectedTurnId = expectedTurnId;
    const turnRes = await request(method, turnParams);

    await new Promise((r) => setTimeout(r, 1500));
    proc.kill("SIGTERM");

    if (turnRes?.error) throw new Error(turnRes.error?.message ?? `${method} failed`);
    return { turn: turnRes.result?.turn ?? null, notifications: notes.slice(0, 50) };
  } catch (error) {
    proc.kill("SIGTERM");
    throw error;
  }
}

async function codexInterruptThread(threadId: string, turnId?: string) {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: proc.stdout });
  let seq = 1;
  const pending = new Map<number, (msg: any) => void>();
  const send = (payload: any) => proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    send({ id, method: m, params: p });
    return new Promise<any>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${m}`)), 10000);
    });
  };
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && !msg.method) {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      }
    } catch {}
  });

  const init = await request("initialize", {
    clientInfo: { name: "oai_app_proxy", title: "oai-app-proxy", version: "0.4.0" },
  });
  if (init?.error) throw new Error(init.error?.message ?? "initialize failed");
  send({ method: "initialized", params: {} });
  const resume = await request("thread/resume", { threadId });
  if (resume?.error) throw new Error(resume.error?.message ?? "thread/resume failed");
  const out = await request("turn/interrupt", turnId ? { threadId, turnId } : { threadId });
  proc.kill("SIGTERM");
  if (out?.error) throw new Error(out.error?.message ?? "turn/interrupt failed");
  return out.result ?? {};
}

async function detectRunningCodexSessions() {
  const threads = await listCodexThreads(100).catch(() => [] as CodexThread[]);
  const byId = new Map(threads.map((t) => [t.id, t]));

  const psOut = await Bun.$`ps -axo pid=,command=`.text();
  const pids = psOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(.+)$/);
      return m ? { pid: Number(m[1]), cmd: m[2] } : null;
    })
    .filter((x): x is { pid: number; cmd: string } => !!x)
    .filter((x) => x.cmd.includes("/Applications/Codex.app/Contents/Resources/codex app-server"));

  const running: Array<Record<string, unknown>> = [];

  for (const p of pids) {
    const lsof = await Bun.$`lsof -p ${p.pid}`.text().catch(() => "");
    for (const line of lsof.split("\n")) {
      const m = line.match(/\s(\d+\w)\s+REG\s+.+\s(\/Users\/hack\/.codex\/sessions\/.+rollout-.+\.jsonl)$/);
      if (!m) continue;
      const fd = m[1] ?? "";
      if (!fd.includes("w")) continue;
      const path = m[2] ?? "";
      const idMatch = path.match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
      const threadId = idMatch?.[1] ?? null;
      const meta = threadId ? byId.get(threadId) : undefined;
      running.push({
        pid: p.pid,
        threadId,
        path,
        cwd: meta?.cwd ?? null,
        preview: meta?.preview ?? null,
        updatedAt: meta?.updatedAt ?? null,
        source: meta?.source ?? null,
      });
    }
  }

  const dedup = new Map<string, Record<string, unknown>>();
  for (const r of running) dedup.set(`${r.pid}:${r.path}`, r);
  return [...dedup.values()];
}

let watcherIntervalSec = 15;
let watcherTimer: Timer | null = null;

async function runWatcherTick() {
  for (const lane of lanes.values()) {
    if (!lane.threadId) continue;
    if (["done", "failed", "interrupted"].includes(lane.status)) continue;

    let thread: CodexThread | null = null;
    try {
      thread = await getCodexThreadById(lane.threadId);
    } catch (error) {
      await emitEvent({
        eventId: randomUUID(),
        laneId: lane.laneId,
        type: "lane.codex.sync_error",
        ts: nowIso(),
        severity: "warn",
        payload: { message: (error as Error).message },
      });
      continue;
    }

    if (!thread) {
      await emitEvent({
        eventId: randomUUID(),
        laneId: lane.laneId,
        type: "lane.codex.thread_missing",
        ts: nowIso(),
        severity: "warn",
        payload: { threadId: lane.threadId },
      });
      continue;
    }

    const prev = attachedThreadLastUpdated.get(lane.threadId) ?? 0;
    const cur = thread.updatedAt ?? 0;
    if (cur > prev) {
      attachedThreadLastUpdated.set(lane.threadId, cur);
      lane.repoRoot = thread.cwd ?? lane.repoRoot;
      lane.surface = thread.surface ?? lane.surface ?? "unknown";
      lane.updatedAt = nowIso();
      await persistLane(lane);
      await emitEvent({
        eventId: randomUUID(),
        laneId: lane.laneId,
        type: "lane.codex.activity",
        ts: nowIso(),
        severity: "info",
        payload: {
          threadId: lane.threadId,
          previousUpdatedAt: prev || null,
          updatedAt: cur,
          cwd: thread.cwd ?? null,
          source: thread.source ?? null,
          surface: thread.surface ?? "unknown",
          preview: (thread.preview ?? "").slice(0, 280) || null,
        },
      });
    }
  }
}

function startWatcher(intervalSec = 15) {
  watcherIntervalSec = Math.max(2, intervalSec);
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = setInterval(() => {
    runWatcherTick().catch(() => null);
  }, watcherIntervalSec * 1000);
}

function stopWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason);
});

await restoreFromDisk();
startWatcher(15);

const cliPortArgIndex = process.argv.findIndex((a) => a === "--port");
const cliPort = cliPortArgIndex >= 0 ? Number(process.argv[cliPortArgIndex + 1]) : NaN;
const bindPort = Number.isFinite(cliPort) ? cliPort : Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port: bindPort,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "GET" && path === "/health") {
      return json({
        ok: true,
        service: "oai-app-proxy",
        version: "v0.4",
        lanes: lanes.size,
        watcher: { running: !!watcherTimer, intervalSec: watcherIntervalSec },
        defaultSurfacePolicy: "mac-app",
      });
    }

    if (method === "GET" && path === "/events/stream") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseClients.add(controller);
          controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: nowIso() })}\n\n`));
        },
        cancel() {
          // cleanup all stale references lazily
          for (const c of sseClients) {
            try {
              if (c.desiredSize === null) sseClients.delete(c);
            } catch {
              sseClients.delete(c);
            }
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (method === "GET" && path === "/watch/status") {
      return json({ running: !!watcherTimer, intervalSec: watcherIntervalSec });
    }

    if (method === "POST" && path === "/watch/start") {
      const body = await parseBody(req);
      startWatcher(Number(body.intervalSec ?? 15));
      return json({ running: true, intervalSec: watcherIntervalSec });
    }

    if (method === "POST" && path === "/watch/stop") {
      stopWatcher();
      return json({ running: false, intervalSec: watcherIntervalSec });
    }

    if (method === "POST" && path === "/watch/tick") {
      await runWatcherTick();
      return json({ ok: true });
    }


    if (method === "GET" && path === "/webhooks") {
      return json({ subscriptions: [...webhookSubscriptions.values()] });
    }

    if (method === "POST" && path === "/webhooks") {
      const body = await parseBody(req);
      const urlVal = String(body.url ?? "");
      if (!urlVal) return json({ error: "url_required" }, 400);
      try {
        new URL(urlVal);
      } catch {
        return json({ error: "invalid_url" }, 400);
      }
      const events = Array.isArray(body.events) ? body.events.map(String) : ["*"];
      const now = nowIso();
      const sub: WebhookSubscription = {
        id: `wh_${randomUUID()}`,
        url: urlVal,
        events,
        enabled: body.enabled === false ? false : true,
        secret: body.secret ? String(body.secret) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      webhookSubscriptions.set(sub.id, sub);
      await persistWebhooks();
      return json({ subscription: sub }, 201);
    }

    const webhookMatch = path.match(/^\/webhooks\/([^/]+)$/);
    if (webhookMatch && method === "PATCH") {
      const id = webhookMatch[1]!;
      const sub = webhookSubscriptions.get(id);
      if (!sub) return json({ error: "webhook_not_found" }, 404);
      const body = await parseBody(req);
      if (body.url !== undefined) {
        const u = String(body.url);
        try { new URL(u); } catch { return json({ error: "invalid_url" }, 400); }
        sub.url = u;
      }
      if (body.events !== undefined) {
        if (!Array.isArray(body.events)) return json({ error: "events_must_be_array" }, 400);
        sub.events = body.events.map(String);
      }
      if (body.enabled !== undefined) sub.enabled = Boolean(body.enabled);
      if (body.secret !== undefined) sub.secret = body.secret ? String(body.secret) : undefined;
      sub.updatedAt = nowIso();
      await persistWebhooks();
      return json({ subscription: sub });
    }

    if (webhookMatch && method === "DELETE") {
      const id = webhookMatch[1]!;
      const existed = webhookSubscriptions.delete(id);
      if (!existed) return json({ error: "webhook_not_found" }, 404);
      await persistWebhooks();
      return json({ ok: true });
    }

    const webhookTestMatch = path.match(/^\/webhooks\/([^/]+)\/test$/);
    if (webhookTestMatch && method === "POST") {
      const id = webhookTestMatch[1]!;
      const sub = webhookSubscriptions.get(id);
      if (!sub) return json({ error: "webhook_not_found" }, 404);
      const evt: LaneEvent = {
        eventId: randomUUID(),
        laneId: "webhook-test",
        type: "webhook.test",
        ts: nowIso(),
        severity: "info",
        payload: { note: "manual test" },
      };
      await dispatchWebhooks(evt);
      return json({ ok: true, subscription: sub });
    }

    if (method === "GET" && path === "/codex/threads") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const sk = (url.searchParams.get("sourceKinds") ?? "").split(",").map((x)=>x.trim()).filter(Boolean);
      try {
        const data = await listCodexThreads(Math.max(1, Math.min(limit, 200)), sk.length ? sk : ["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]);
        return json({ threads: data, count: data.length });
      } catch (error) {
        return json({ error: "codex_rpc_failed", message: (error as Error).message }, 502);
      }
    }

    const codexThreadMatch = path.match(/^\/codex\/threads\/([^/]+)$/);
    if (method === "GET" && codexThreadMatch) {
      const threadId = codexThreadMatch[1]!;
      try {
        const thread = await getCodexThreadById(threadId);
        if (!thread) return json({ error: "thread_not_found" }, 404);
        return json({ thread });
      } catch (error) {
        return json({ error: "codex_rpc_failed", message: (error as Error).message }, 502);
      }
    }


    if (method === "POST" && path === "/codex/threads/start") {
      const body = await parseBody(req);
      try {
        const thread = await codexThreadStart({ model: body.model as string | undefined });
        if (!thread) return json({ error: "thread_start_failed" }, 502);
        return json({ thread }, 201);
      } catch (error) {
        return json({ error: "codex_thread_start_failed", message: (error as Error).message }, 502);
      }
    }


    if (method === "POST" && path === "/codex/workflows/start-visible") {
      const body = await parseBody(req);
      const laneId = String(body.laneId ?? `lane-${randomUUID()}`);
      const projectId = String(body.projectId ?? "").trim() || undefined;
      const repoRoot = String(body.repoRoot ?? "").trim() || undefined;
      const title = String(body.title ?? "").trim() || undefined;
      const kickoff = String(body.kickoffPrompt ?? "").trim() || undefined;

      try {
        const started = await codexStartThreadWithOptionalTurn({
          model: body.model as string | undefined,
          cwd: repoRoot,
          kickoffPrompt: kickoff,
        });
        const thread = started.thread;
        const turnId: string | null = started.turnId;

        if (title) {
          try { await codexThreadSetName(thread.id, title); } catch {}
        }

        if (lanes.has(laneId)) return json({ error: "lane_exists" }, 409);
        const now = nowIso();
        const lane: Lane = {
          laneId,
          projectId: projectId ?? (thread.cwd ? thread.cwd.split("/").pop() : undefined),
          repoRoot: repoRoot ?? thread.cwd,
          threadId: thread.id,
          activeTurnId: turnId ?? undefined,
          preferredSurface: "any",
          surface: thread.surface ?? "unknown",
          status: "running",
          acceptanceCriteria: (body.acceptanceCriteria as string[] | undefined) ?? [],
          verificationCommands: (body.verificationCommands as string[] | undefined) ?? [],
          createdAt: now,
          updatedAt: now,
        };

        lanes.set(laneId, lane);
        approvals.set(laneId, []);
        attachedThreadLastUpdated.set(thread.id, thread.updatedAt ?? 0);
        await persistLane(lane);
        await emitEvent({
          eventId: randomUUID(),
          laneId,
          type: "lane.started.visible_workflow",
          ts: now,
          severity: "info",
          payload: { threadId: thread.id, source: thread.source ?? null, surface: thread.surface ?? "unknown", title: title ?? null },
        });

        return json({ lane, thread, turnId }, 201);
      } catch (error) {
        return json({ error: "visible_workflow_failed", message: (error as Error).message }, 502);
      }
    }

    const codexTurnMatch = path.match(/^\/codex\/threads\/([^/]+)\/turns\/(start|steer|interrupt)$/);
    if (method === "POST" && codexTurnMatch) {
      const threadId = codexTurnMatch[1]!;
      const action = codexTurnMatch[2]!;
      const body = await parseBody(req);
      try {
        if (action === "interrupt") {
          const result = await codexInterruptThread(threadId, body.turnId ? String(body.turnId) : undefined);
          return json({ ok: true, result });
        }
        const input = String(body.input ?? "").trim();
        if (!input) return json({ error: "input_required" }, 400);
        const result = await codexTurnOnThread(threadId, input, action === "steer" ? "steer" : "start", body.expectedTurnId ? String(body.expectedTurnId) : undefined);
        return json({ ok: true, result });
      } catch (error) {
        return json({ error: "codex_turn_failed", message: (error as Error).message }, 502);
      }
    }

    if (method === "GET" && path === "/codex/active") {
      const windowSec = Number(url.searchParams.get("windowSec") ?? 300);
      try {
        const source = url.searchParams.get("source");
        const sourceKinds = (url.searchParams.get("sourceKinds") ?? "").split(",").map((x)=>x.trim()).filter(Boolean);
        const surface = (url.searchParams.get("surface") ?? "").trim();
        const originator = (url.searchParams.get("originator") ?? "").trim();
        const preferOriginator = (url.searchParams.get("preferOriginator") ?? "").trim();
        const preferredSurface = (url.searchParams.get("preferredSurface") ?? "mac-app").trim();
        const threads = await listCodexThreads(200, sourceKinds.length ? sourceKinds : ["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]);
        const now = Math.floor(Date.now() / 1000);
        let active = threads.filter((t) => typeof t.updatedAt === "number" && now - t.updatedAt <= windowSec && (!source || t.source === source) && (!surface || t.surface === surface) && (!originator || t.originator === originator));
        active.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

        if (preferOriginator) {
          const prefOrg = active.filter((t) => t.originator === preferOriginator);
          if (prefOrg.length > 0) active = prefOrg;
        }

        if (preferredSurface && preferredSurface !== "any") {
          const preferred = active.filter((t) => t.surface === preferredSurface);
          if (preferred.length > 0) active = preferred;
        }

        return json({ windowSec, source: source ?? null, sourceKinds, surface: surface || null, originator: originator || null, preferOriginator: preferOriginator || null, preferredSurface, count: active.length, threads: active });
      } catch (error) {
        return json({ error: "codex_active_detect_failed", message: (error as Error).message }, 502);
      }
    }

    if (method === "GET" && path === "/codex/running") {
      try {
        const sessions = await detectRunningCodexSessions();
        return json({ sessions, count: sessions.length });
      } catch (error) {
        return json({ error: "codex_running_detect_failed", message: (error as Error).message }, 502);
      }
    }

    if (method === "GET" && path === "/lanes") {
      return json({ lanes: [...lanes.values()] });
    }

    if (method === "POST" && path === "/lanes/attach") {
      const body = await parseBody(req);
      const threadId = String(body.threadId ?? "");
      if (!threadId) return json({ error: "thread_id_required" }, 400);

      let thread: CodexThread | null = null;
      try {
        thread = await getCodexThreadById(threadId);
      } catch (error) {
        return json({ error: "codex_rpc_failed", message: (error as Error).message }, 502);
      }
      if (!thread) return json({ error: "thread_not_found" }, 404);

      const preferredSurface = String(body.preferredSurface ?? "mac-app") as Lane["preferredSurface"];
      const requirePreferredSurface = body.requirePreferredSurface === undefined ? true : Boolean(body.requirePreferredSurface);
      const detectedSurface = thread.surface ?? "unknown";
      if (requirePreferredSurface && preferredSurface && preferredSurface !== "any" && detectedSurface !== preferredSurface) {
        return json({ error: "surface_mismatch", message: `thread surface ${detectedSurface} does not match preferredSurface ${preferredSurface}` }, 409);
      }

      const laneId = String(body.laneId ?? `lane-${randomUUID()}`);
      if (lanes.has(laneId)) return json({ error: "lane_exists" }, 409);

      const now = nowIso();
      const lane: Lane = {
        laneId,
        projectId: (body.projectId as string | undefined) ?? (thread.cwd ? thread.cwd.split("/").pop() : undefined),
        repoRoot: (body.repoRoot as string | undefined) ?? thread.cwd,
        nodeId: body.nodeId as string | undefined,
        worktreePath: body.worktreePath as string | undefined,
        branch: body.branch as string | undefined,
        threadId,
        activeTurnId: undefined,
        preferredSurface,
        surface: detectedSurface,
        status: "running",
        acceptanceCriteria: (body.acceptanceCriteria as string[] | undefined) ?? [],
        verificationCommands: (body.verificationCommands as string[] | undefined) ?? [],
        createdAt: now,
        updatedAt: now,
      };

      lanes.set(laneId, lane);
      approvals.set(laneId, []);
      attachedThreadLastUpdated.set(threadId, thread.updatedAt ?? 0);
      await persistLane(lane);
      await emitEvent({
        eventId: randomUUID(),
        laneId,
        type: "lane.attached",
        ts: now,
        severity: "info",
        payload: { threadId, cwd: thread.cwd ?? null, source: thread.source ?? null, surface: thread.surface ?? "unknown" },
      });
      return json({ lane, thread }, 201);
    }

    if (method === "POST" && path === "/lanes") {
      const body = await parseBody(req);
      const laneId = String(body.laneId ?? `lane-${randomUUID()}`);
      if (lanes.has(laneId)) return json({ error: "lane_exists" }, 409);
      const now = nowIso();
      const lane: Lane = {
        laneId,
        projectId: body.projectId as string | undefined,
        repoRoot: body.repoRoot as string | undefined,
        nodeId: body.nodeId as string | undefined,
        worktreePath: body.worktreePath as string | undefined,
        branch: body.branch as string | undefined,
        threadId: body.threadId as string | undefined,
        activeTurnId: undefined,
        status: "starting",
        acceptanceCriteria: (body.acceptanceCriteria as string[] | undefined) ?? [],
        verificationCommands: (body.verificationCommands as string[] | undefined) ?? [],
        createdAt: now,
        updatedAt: now,
      };
      lanes.set(laneId, lane);
      approvals.set(laneId, []);
      await persistLane(lane);
      await emitEvent({ eventId: randomUUID(), laneId, type: "lane.started", ts: now, severity: "info" });
      await setLaneStatus(lane, "running", "lane.running");
      return json({ lane }, 201);
    }

    const syncMatch = path.match(/^\/lanes\/([^/]+)\/sync-from-codex$/);
    if (method === "POST" && syncMatch) {
      const laneId = syncMatch[1]!;
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);
      if (!lane.threadId) return json({ error: "lane_not_attached" }, 400);

      let thread: CodexThread | null = null;
      try {
        thread = await getCodexThreadById(lane.threadId);
      } catch (error) {
        return json({ error: "codex_rpc_failed", message: (error as Error).message }, 502);
      }
      if (!thread) return json({ error: "thread_not_found" }, 404);

      lane.repoRoot = thread.cwd ?? lane.repoRoot;
      lane.surface = thread.surface ?? lane.surface ?? "unknown";
      lane.updatedAt = nowIso();
      attachedThreadLastUpdated.set(lane.threadId, thread.updatedAt ?? 0);
      await persistLane(lane);
      await emitEvent({
        eventId: randomUUID(),
        laneId,
        type: "lane.synced_from_codex",
        ts: nowIso(),
        severity: "info",
        payload: { threadId: lane.threadId, cwd: thread.cwd ?? null, source: thread.source ?? null, updatedAt: thread.updatedAt ?? null },
      });

      return json({ lane, thread });
    }

    const laneMatch = path.match(/^\/lanes\/([^/]+)$/);
    if (method === "GET" && laneMatch) {
      const laneId = laneMatch[1]!;
      const lane = getLaneOr404(laneId);
      return lane ? json({ lane }) : json({ error: "lane_not_found" }, 404);
    }

    const eventMatch = path.match(/^\/lanes\/([^/]+)\/events$/);
    if (method === "GET" && eventMatch) {
      const laneId = eventMatch[1]!;
      if (!lanes.has(laneId)) return json({ error: "lane_not_found" }, 404);
      return json({ events: laneEvents.get(laneId) ?? [] });
    }


    const laneSessionMatch = path.match(/^\/lanes\/([^/]+)\/session\/(start|stop|status)$/);
    if (laneSessionMatch) {
      const laneId = laneSessionMatch[1]!;
      const op = laneSessionMatch[2]!;
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);

      if (op === "status" && method === "GET") {
        const sess = laneSessions.get(laneId);
        return json({
          running: !!sess,
          threadId: lane.threadId ?? null,
          startedAt: sess?.startedAt ?? null,
          pendingRequests: sess ? sess.serverRequests.size : 0,
          activeTurnId: lane.activeTurnId ?? null,
        });
      }

      if (op === "start" && method === "POST") {
        if (!lane.threadId) return json({ error: "lane_not_attached" }, 400);
        try {
          const sess = await startLaneSession(lane);
          return json({ ok: true, running: true, startedAt: sess.startedAt, threadId: lane.threadId });
        } catch (error) {
          return json({ error: "lane_session_start_failed", message: (error as Error).message }, 502);
        }
      }

      if (op === "stop" && method === "POST") {
        const stopped = await stopLaneSession(laneId);
        await emitEvent({ eventId: randomUUID(), laneId, type: "lane.session.stopped", ts: nowIso(), severity: "info" });
        return json({ ok: true, stopped });
      }
    }

    const promptMatch = path.match(/^\/lanes\/([^/]+)\/(prompt|steer|interrupt)$/);
    if (method === "POST" && promptMatch) {
      const laneId = promptMatch[1]!;
      const action = promptMatch[2]!;
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);

      const body = await parseBody(req);
      if (lane.threadId) {
        try {
          const session = laneSessions.get(laneId) ?? (await startLaneSession(lane));

          if (action === "interrupt") {
            if (!lane.activeTurnId) return json({ error: "no_active_turn" }, 409);
            const res = await laneSessionRequest(laneId, "turn/interrupt", { threadId: lane.threadId, turnId: lane.activeTurnId });
            if (res?.error) throw new Error(res.error?.message ?? "turn/interrupt failed");
            await setLaneStatus(lane, "interrupted", "lane.interrupted", { threadId: lane.threadId, turnId: lane.activeTurnId });
            lane.activeTurnId = undefined;
            await persistLane(lane);
            return json({ ok: true, lane });
          }

          const input = String(body.input ?? "").trim();
          if (!input) return json({ error: "input_required" }, 400);

          if (action === "steer") {
            if (!lane.activeTurnId) return json({ error: "no_active_turn", message: "steer requires an active turn" }, 409);
            const res = await laneSessionRequest(laneId, "turn/steer", { threadId: lane.threadId, expectedTurnId: lane.activeTurnId, input: [{ type: "text", text: input }] });
            if (res?.error) throw new Error(res.error?.message ?? "turn/steer failed");
          } else {
            const res = await laneSessionRequest(laneId, "turn/start", { threadId: lane.threadId, input: [{ type: "text", text: input }] });
            if (res?.error) throw new Error(res.error?.message ?? "turn/start failed");
            if (res?.result?.turn?.id) lane.activeTurnId = String(res.result.turn.id);
          }

          lane.updatedAt = nowIso();
          await persistLane(lane);
          await emitEvent({
            eventId: randomUUID(),
            laneId,
            type: action === "prompt" ? "lane.turn.started" : "lane.turn.steered",
            ts: nowIso(),
            severity: "info",
            payload: { input, threadId: lane.threadId, turnId: lane.activeTurnId ?? null, sessionStartedAt: session.startedAt },
          });

          return json({ ok: true, lane });
        } catch (error) {
          await emitEvent({
            eventId: randomUUID(),
            laneId,
            type: "lane.turn.failed",
            ts: nowIso(),
            severity: "error",
            payload: { message: (error as Error).message, action, threadId: lane.threadId },
          });
          return json({ error: "codex_turn_failed", message: (error as Error).message }, 502);
        }
      }

      if (action === "interrupt") {
        await setLaneStatus(lane, "interrupted", "lane.interrupted");
      } else {
        await emitEvent({
          eventId: randomUUID(),
          laneId,
          type: action === "prompt" ? "lane.turn.started" : "lane.turn.steered",
          ts: nowIso(),
          severity: "info",
          payload: { input: body.input ?? null },
        });
      }
      return json({ ok: true, lane });
    }

    const approvalListMatch = path.match(/^\/lanes\/([^/]+)\/approvals$/);
    if (method === "GET" && approvalListMatch) {
      const laneId = approvalListMatch[1]!;
      if (!lanes.has(laneId)) return json({ error: "lane_not_found" }, 404);
      return json({ approvals: approvals.get(laneId) ?? [] });
    }

    const approvalActionMatch = path.match(/^\/lanes\/([^/]+)\/approvals\/([^/]+)\/(approve|deny)$/);
    if (method === "POST" && approvalActionMatch) {
      const laneId = approvalActionMatch[1]!;
      const approvalId = approvalActionMatch[2]!;
      const action = approvalActionMatch[3]!;
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);

      const list = approvals.get(laneId) ?? [];
      const item = list.find((a) => a.approvalId === approvalId);
      if (!item) return json({ error: "approval_not_found" }, 404);

      item.status = action === "approve" ? "approved" : "denied";
      item.resolvedAt = nowIso();

      if (item.rpcRequestId !== undefined && laneSessions.has(laneId)) {
        await laneSessionRespondApproval(laneId, item.rpcRequestId, item.status === "approved" ? "approved" : "denied");
      }

      await emitEvent({
        eventId: randomUUID(),
        laneId,
        type: "lane.approval.resolved",
        ts: item.resolvedAt,
        severity: "info",
        payload: { approvalId, status: item.status },
      });

      if (lane.status === "needs_approval" && item.status === "approved") {
        await setLaneStatus(lane, "running", "lane.running");
      }

      await persistLane(lane);
      return json({ approval: item, lane });
    }

    if (method === "POST" && path === "/debug/request-approval") {
      const body = await parseBody(req);
      const laneId = String(body.laneId ?? "");
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);

      const approval: Approval = {
        approvalId: `apr_${randomUUID()}`,
        laneId,
        source: (body.source as Approval["source"]) ?? "app-server",
        reason: String(body.reason ?? "manual debug approval"),
        status: "pending",
        createdAt: nowIso(),
      };

      const list = approvals.get(laneId) ?? [];
      list.push(approval);
      approvals.set(laneId, list);

      await setLaneStatus(lane, "needs_approval", "lane.approval.requested", {
        approvalId: approval.approvalId,
        reason: approval.reason,
      });

      return json({ approval, lane });
    }

    if (method === "POST" && path === "/debug/complete") {
      const body = await parseBody(req);
      const laneId = String(body.laneId ?? "");
      const lane = getLaneOr404(laneId);
      if (!lane) return json({ error: "lane_not_found" }, 404);
      lane.status = "done";
      lane.updatedAt = nowIso();
      await persistLane(lane);
      await emitLaneCompletion(lane, {}, String(body.note ?? "debug complete"));
      return json({ lane });
    }

    return json({ error: "not_found" }, 404);
  },
});

console.log(`oai-app-proxy v0.4 listening on http://localhost:${server.port}`);
