import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

const APP_VERSION = "v0.5.1";
const CODEX_APP_SERVER_VERSION = "0.5.0";
const GIT_STATUS_PREFIX_REGEX = /^..\s+/;
const EVENT_LOG_SUFFIX_REGEX = /\.jsonl$/;
const PROCESS_LIST_LINE_REGEX = /^(\d+)\s+(.+)$/;
const LSOF_SESSION_PATH_REGEX =
  /\s(\d+\w)\s+REG\s+.+\s(\/Users\/hack\/.codex\/sessions\/.+rollout-.+\.jsonl)$/;
const THREAD_ID_FROM_SESSION_PATH_REGEX =
  /-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;

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

export interface Lane {
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
}

interface LaneEvent {
  eventId: string;
  laneId: string;
  type: string;
  ts: string;
  severity: "info" | "warn" | "error";
  payload?: Record<string, unknown>;
}

interface Approval {
  approvalId: string;
  laneId: string;
  source: "app-server" | "runtime";
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt?: string;
  rpcRequestId?: string | number;
  rpcMethod?: string;
  rpcParams?: Record<string, unknown>;
}

export interface CodexThread {
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
}

interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt?: string;
  lastError?: string;
}

interface LaneSession {
  laneId: string;
  threadId?: string;
  proc: ReturnType<typeof spawn>;
  rl: readline.Interface;
  seq: number;
  pending: Map<
    string | number,
    {
      resolve: (msg: JsonRpcMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  serverRequests: Map<
    string | number,
    { method: string; params: Record<string, unknown> }
  >;
  startedAt: string;
  readyAt?: string;
  sessionStartedEventEmitted: boolean;
  closing: boolean;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface StartLaneSessionOptions {
  waitForThreadResume?: boolean;
  emitStartedEvent?: boolean;
}

interface ThreadReadinessResult {
  attempts: number;
  deferred: boolean;
  reason: string | null;
}

const lanes = new Map<string, Lane>();
const laneEvents = new Map<string, LaneEvent[]>();
const approvals = new Map<string, Approval[]>();
const attachedThreadLastUpdated = new Map<string, number>();
const webhookSubscriptions = new Map<string, WebhookSubscription>();
const laneSessions = new Map<string, LaneSession>();
const threadToLaneSession = new Map<string, string>();

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const dataRoot = join(process.cwd(), "data");
const laneDir = join(dataRoot, "lanes");
const eventDir = join(dataRoot, "events");
const webhookFile = join(dataRoot, "webhooks.json");

await mkdir(laneDir, { recursive: true });
await mkdir(eventDir, { recursive: true });

function fireAndForget(task: Promise<unknown>) {
  task.catch(() => undefined);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSurface(
  source?: unknown
): "mac-app" | "vscode" | "cli" | "unknown" {
  if (typeof source !== "string") {
    return "unknown";
  }
  const s = source.toLowerCase();
  if (s === "vscode") {
    return "vscode";
  }
  if (s === "cli") {
    return "cli";
  }
  if (s === "app" || s === "desktop" || s === "mac-app" || s === "codex-app") {
    return "mac-app";
  }
  return "unknown";
}

interface GlobalCodexState {
  titles: Record<string, string>;
  pinned: Set<string>;
  activeRoots: string[];
}

async function readCodexGlobalState(): Promise<GlobalCodexState> {
  const home = process.env.HOME ?? "";
  const out: GlobalCodexState = {
    titles: {},
    pinned: new Set<string>(),
    activeRoots: [],
  };
  if (!home) {
    return out;
  }
  try {
    const raw = await readFile(
      join(home, ".codex", ".codex-global-state.json"),
      "utf8"
    );
    const j = JSON.parse(raw) as Record<string, unknown>;
    const tt = (j["thread-titles"] ?? {}) as Record<string, unknown>;
    const titles = (tt.titles ?? {}) as Record<string, unknown>;
    out.titles = Object.fromEntries(
      Object.entries(titles).filter(([, v]) => typeof v === "string")
    ) as Record<string, string>;
    const pinned = (j["pinned-thread-ids"] ?? []) as unknown[];
    out.pinned = new Set<string>(
      pinned.filter((x): x is string => typeof x === "string")
    );
    const roots = (j["active-workspace-roots"] ?? []) as unknown[];
    out.activeRoots = roots.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore
  }
  return out;
}

async function readOriginatorFromRollout(
  pathVal?: string
): Promise<string | null> {
  if (!pathVal) {
    return null;
  }
  try {
    const raw = await Bun.file(pathVal).slice(0, 8192).text();
    const first = raw.split("\n")[0] ?? "";
    if (!first.trim()) {
      return null;
    }
    const obj = JSON.parse(first) as Record<string, unknown>;
    const payload = (obj.payload ?? obj) as Record<string, unknown>;
    const originator = payload.originator;
    return typeof originator === "string" ? originator : null;
  } catch {
    return null;
  }
}

async function enrichCodexThread(
  t: CodexThread,
  state?: GlobalCodexState
): Promise<CodexThread> {
  const g = state ?? (await readCodexGlobalState());
  const originator = await readOriginatorFromRollout(t.path);
  const title = g.titles[t.id] ?? null;
  const pinned = g.pinned.has(t.id);
  const desktopLikely =
    originator === "Codex Desktop" ||
    (t.source === "vscode" &&
      !!t.cwd &&
      g.activeRoots.some((r) => t.cwd?.startsWith(r)));
  return {
    ...t,
    originator,
    title,
    pinned,
    desktopLikely,
  };
}

const encoder = new TextEncoder();

function debugLog(message: string, details?: Record<string, unknown>) {
  if (process.env.E2E_DEBUG !== "1") {
    return;
  }
  if (details) {
    console.log(`[oai-app-proxy] ${message}`, JSON.stringify(details));
  } else {
    console.log(`[oai-app-proxy] ${message}`);
  }
}

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
  await writeFile(
    join(laneDir, `${lane.laneId}.json`),
    JSON.stringify(lane, null, 2)
  );
}

async function emitEvent(event: LaneEvent) {
  const events = laneEvents.get(event.laneId) ?? [];
  events.push(event);
  laneEvents.set(event.laneId, events);
  await appendFile(
    join(eventDir, `${event.laneId}.jsonl`),
    `${JSON.stringify(event)}\n`
  );
  sseBroadcast("lane_event", event);
  await dispatchWebhooks(event);
}

async function setLaneStatus(
  lane: Lane,
  status: LaneStatus,
  type: string,
  payload?: Record<string, unknown>
) {
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

async function parseBody(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function eventMatches(pattern: string, eventType: string) {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith("*")) {
    return eventType.startsWith(pattern.slice(0, -1));
  }
  return pattern === eventType;
}

function codexBinary() {
  return process.env.CODEX_BIN ?? "codex";
}

function getCodexInitializeCapabilities() {
  const capabilities: Record<string, unknown> = {};
  const rawOptOut = process.env.CODEX_OPT_OUT_NOTIFICATIONS;
  const experimental = process.env.CODEX_EXPERIMENTAL_API;
  if (experimental === "1" || experimental === "true") {
    capabilities.experimentalApi = true;
  }
  if (rawOptOut) {
    const parsed =
      rawOptOut.startsWith("[") && rawOptOut.endsWith("]")
        ? (() => {
            try {
              return JSON.parse(rawOptOut);
            } catch {
              return [];
            }
          })()
        : rawOptOut
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
    if (Array.isArray(parsed) && parsed.length > 0) {
      capabilities.optOutNotificationMethods = parsed.filter(
        (value) => typeof value === "string"
      );
    }
  }
  if (Object.keys(capabilities).length === 0) {
    return undefined;
  }
  return capabilities;
}

function getCodexInitializePayload() {
  const capabilities = getCodexInitializeCapabilities();
  return capabilities
    ? {
        clientInfo: {
          name: "oai_app_proxy",
          title: "oai-app-proxy",
          version: CODEX_APP_SERVER_VERSION,
        },
        capabilities,
      }
    : {
        clientInfo: {
          name: "oai_app_proxy",
          title: "oai-app-proxy",
          version: CODEX_APP_SERVER_VERSION,
        },
      };
}

async function persistWebhooks() {
  const list = [...webhookSubscriptions.values()];
  await writeFile(
    webhookFile,
    JSON.stringify({ subscriptions: list }, null, 2)
  );
}

async function dispatchWebhooks(event: LaneEvent) {
  const subs = [...webhookSubscriptions.values()].filter(
    (w) => w.enabled && w.events.some((e) => eventMatches(e, event.type))
  );
  if (!subs.length) {
    return;
  }

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
    })
  );

  await persistWebhooks();
}

function isNoRolloutFoundError(message: string) {
  return message.toLowerCase().includes("no rollout found");
}

function getRpcErrorMessage(msg: JsonRpcMessage, fallback: string): string {
  return String(msg.error?.message ?? fallback);
}

function getTurnId(record?: Record<string, unknown>): string | null {
  if (!record) {
    return null;
  }
  const turn = record.turn;
  if (!turn || typeof turn !== "object") {
    return null;
  }
  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function laneNotificationEventType(method: string) {
  return `lane.${method.replaceAll("/", ".")}.notification`;
}

function clearThreadLaneMappingsForLane(laneId: string) {
  for (const [threadId, mappedLaneId] of threadToLaneSession.entries()) {
    if (mappedLaneId === laneId) {
      threadToLaneSession.delete(threadId);
    }
  }
}

function linkThreadToLaneSession(threadId: string | undefined, laneId: string) {
  if (!threadId) {
    return;
  }
  threadToLaneSession.set(threadId, laneId);
}

function unlinkThreadFromLaneSession(
  threadId: string | undefined,
  laneId?: string
) {
  if (!threadId) {
    return;
  }
  const mappedLaneId = threadToLaneSession.get(threadId);
  if (mappedLaneId === laneId || laneId === undefined) {
    threadToLaneSession.delete(threadId);
  }
}

async function emitLaneSessionNotification(
  lane: Lane,
  method: string,
  params: Record<string, unknown>
) {
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: laneNotificationEventType(method),
    ts: nowIso(),
    severity: "info",
    payload: {
      method,
      ...params,
      threadId:
        (params.threadId as string | undefined) ?? lane.threadId ?? null,
    },
  });
}

async function sleepMs(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function laneSessionRequest(
  laneId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000
) {
  const s = laneSessions.get(laneId);
  if (!s) {
    throw new Error("lane session not running");
  }
  const id = s.seq++;
  const stdin = s.proc.stdin;
  if (!stdin) {
    throw new Error("lane session stdin unavailable");
  }
  debugLog("lane_session_request:send", {
    laneId,
    method,
    requestId: id,
    timeoutMs,
  });
  const written = stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  if (!written) {
    await new Promise<void>((resolve) => {
      stdin.once("drain", () => {
        resolve();
      });
    });
  }
  return await new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      debugLog("lane_session_request:timeout", {
        laneId,
        method,
        requestId: id,
      });
      reject(new Error(`timeout:${method}`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer });
  });
}

async function emitLaneSessionStarted(
  lane: Lane,
  session: LaneSession,
  readiness: ThreadReadinessResult
) {
  if (session.sessionStartedEventEmitted) {
    return;
  }
  const readyAt = nowIso();
  session.readyAt = readyAt;
  session.sessionStartedEventEmitted = true;
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: "lane.session.started",
    ts: readyAt,
    severity: "info",
    payload: {
      threadId: lane.threadId ?? session.threadId ?? null,
      attempts: readiness.attempts,
      deferred: readiness.deferred,
      reason: readiness.reason,
      readyAt,
    },
  });
}

async function waitForThreadReadiness(
  lane: Lane,
  maxAttempts = 10,
  allowNoRolloutTerminal = false
): Promise<ThreadReadinessResult> {
  if (!lane.threadId) {
    throw new Error("lane has no threadId");
  }
  let lastErr: string | null = null;
  let backoffMs = 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const readRes = await laneSessionRequest(lane.laneId, "thread/read", {
      threadId: lane.threadId,
    });
    if (readRes.error) {
      lastErr = getRpcErrorMessage(readRes, "thread/read failed");
      if (!isNoRolloutFoundError(lastErr)) {
        throw new Error(lastErr);
      }
    } else {
      const resumeRes = await laneSessionRequest(lane.laneId, "thread/resume", {
        threadId: lane.threadId,
      });
      if (!resumeRes.error) {
        return { attempts: attempt, deferred: false, reason: null };
      }

      lastErr = getRpcErrorMessage(resumeRes, "thread/resume failed");
      if (!isNoRolloutFoundError(lastErr)) {
        throw new Error(lastErr);
      }
    }

    if (attempt < maxAttempts) {
      await sleepMs(backoffMs);
      backoffMs = Math.min(2000, Math.floor(backoffMs * 1.8));
    }
  }

  if (allowNoRolloutTerminal && lastErr && isNoRolloutFoundError(lastErr)) {
    return { attempts: maxAttempts, deferred: true, reason: lastErr };
  }

  throw new Error(lastErr ?? "thread readiness failed");
}

async function maybeReuseLaneSession(
  lane: Lane,
  waitForThreadResume: boolean,
  emitStartedEvent: boolean
) {
  const existing = laneSessions.get(lane.laneId);
  if (!existing) {
    return null;
  }
  if (existing.threadId !== lane.threadId) {
    if (existing.threadId) {
      unlinkThreadFromLaneSession(existing.threadId, lane.laneId);
    }
    existing.threadId = lane.threadId;
  }
  if (lane.threadId) {
    linkThreadToLaneSession(lane.threadId, lane.laneId);
  }
  if (waitForThreadResume && lane.threadId && !existing.readyAt) {
    const ready = await waitForThreadReadiness(lane);
    if (emitStartedEvent) {
      await emitLaneSessionStarted(lane, existing, ready);
    }
  }
  return existing;
}

function settleLaneSessionPending(session: LaneSession, reason: string) {
  for (const [id, p] of session.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    session.pending.delete(id);
  }
}

function cleanupLaneSession(laneId: string, session: LaneSession) {
  if (laneSessions.get(laneId) === session) {
    laneSessions.delete(laneId);
  }
  clearThreadLaneMappingsForLane(laneId);
}

function scheduleLaneBlockedOnSessionExit(
  lane: Lane,
  code: number | null,
  signal: string | null
) {
  if (["done", "failed", "interrupted"].includes(lane.status)) {
    return;
  }
  fireAndForget(
    setLaneStatus(lane, "blocked", "lane.session.exited", {
      threadId: lane.threadId ?? null,
      code,
      signal,
    })
  );
}

function createLaneSessionSend(session: LaneSession, lane: Lane) {
  return (payload: Record<string, unknown>) => {
    const stdin = session.proc.stdin;
    if (!stdin) {
      throw new Error("lane session stdin unavailable");
    }
    const wrote = stdin.write(`${JSON.stringify(payload)}\n`);
    if (!wrote) {
      debugLog("lane_session_stdin_drain", {
        laneId: lane.laneId,
      });
      stdin.once("drain", () => undefined);
    }
  };
}

function createLaneSessionRequest(
  session: LaneSession,
  lane: Lane,
  send: (payload: Record<string, unknown>) => void
) {
  return async (method: string, params: Record<string, unknown>) => {
    const id = session.seq++;
    send({ id, method, params });
    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        debugLog("lane_session_request:timeout", {
          laneId: lane.laneId,
          method,
          requestId: id,
        });
        reject(new Error(`timeout:${method}`));
      }, 15_000);
      session.pending.set(id, { resolve, reject, timer });
    });
  };
}

function handleLaneSessionRpcResponse(
  laneId: string,
  session: LaneSession,
  msg: JsonRpcMessage
) {
  if (msg.id === undefined || msg.method !== undefined) {
    return false;
  }
  const resolvedId = msg.id;
  const pendingRequest = session.pending.get(msg.id);
  if (pendingRequest) {
    clearTimeout(pendingRequest.timer);
    session.pending.delete(resolvedId);
    pendingRequest.resolve(msg);
    return true;
  }
  debugLog("lane_session_request:orphan_response", {
    laneId,
    requestId: resolvedId,
    matchedPending: false,
  });
  return true;
}

function handleLaneSessionApprovalRequest(lane: Lane, msg: JsonRpcMessage) {
  if (msg.id === undefined || !msg.method) {
    return false;
  }
  sessionApprovalStore(msg.id, msg, lane);
  return true;
}

function sessionApprovalStore(
  requestId: string | number,
  msg: JsonRpcMessage,
  lane: Lane
) {
  const method = String(msg.method ?? "");
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const laneSession = laneSessions.get(lane.laneId);
  if (!laneSession) {
    return;
  }
  laneSession.serverRequests.set(requestId, { method, params });
  if (!method.includes("requestApproval")) {
    return;
  }
  const approval: Approval = {
    approvalId: `apr_${randomUUID()}`,
    laneId: lane.laneId,
    source: "app-server",
    reason: method,
    status: "pending",
    createdAt: nowIso(),
    rpcRequestId: requestId,
    rpcMethod: method,
    rpcParams: params,
  };
  const list = approvals.get(lane.laneId) ?? [];
  list.push(approval);
  approvals.set(lane.laneId, list);
  fireAndForget(
    setLaneStatus(lane, "needs_approval", "lane.approval.requested", {
      approvalId: approval.approvalId,
      reason: approval.reason,
      rpcRequestId: approval.rpcRequestId ?? null,
      rpcMethod: approval.rpcMethod ?? null,
      rpcParams: approval.rpcParams ?? {},
    })
  );
}

function queueLaneTurnStarted(lane: Lane, params: Record<string, unknown>) {
  const turnStartedId = getTurnId(params);
  if (!turnStartedId) {
    return false;
  }
  lane.activeTurnId = turnStartedId;
  lane.updatedAt = nowIso();
  fireAndForget(persistLane(lane));
  fireAndForget(
    emitEvent({
      eventId: randomUUID(),
      laneId: lane.laneId,
      type: "lane.turn.started.notification",
      ts: nowIso(),
      severity: "info",
      payload: { turnId: lane.activeTurnId, threadId: lane.threadId },
    })
  );
  return true;
}

function queueLaneTurnCompleted(lane: Lane, params: Record<string, unknown>) {
  lane.updatedAt = nowIso();
  lane.activeTurnId = undefined;
  fireAndForget(persistLane(lane));
  fireAndForget(emitLaneCompletion(lane, params));
  fireAndForget(emitLaneSessionNotification(lane, "turn/completed", params));
}

function queueLaneSessionNotification(
  lane: Lane,
  method: string,
  params: Record<string, unknown>
) {
  if (method === "turn/started" && queueLaneTurnStarted(lane, params)) {
    return true;
  }
  if (method === "turn/completed") {
    queueLaneTurnCompleted(lane, params);
    return true;
  }
  if (
    method === "error" ||
    method.startsWith("item/") ||
    method.startsWith("turn/") ||
    method.startsWith("thread/")
  ) {
    fireAndForget(
      emitLaneSessionNotification(
        lane,
        method === "error" ? "error" : method,
        params
      )
    );
    return true;
  }
  return false;
}

function attachLaneSessionLineHandler(session: LaneSession, lane: Lane) {
  session.rl.on("line", (line) => {
    debugLog("lane_session_raw_line", {
      laneId: lane.laneId,
      line: line.slice(0, 300),
    });
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (handleLaneSessionRpcResponse(lane.laneId, session, msg)) {
        return;
      }
      if (handleLaneSessionApprovalRequest(lane, msg)) {
        return;
      }
      const method = String(msg.method ?? "");
      if (!method) {
        return;
      }
      const params = (msg.params ?? {}) as Record<string, unknown>;
      queueLaneSessionNotification(lane, method, params);
    } catch {
      // ignore parse errors
    }
  });
}

function registerLaneSessionProcessHandlers(session: LaneSession, lane: Lane) {
  session.proc.on("error", (error) => {
    settleLaneSessionPending(
      session,
      `lane_session_error:${(error as Error).message}`
    );
  });

  session.proc.on("exit", (code, signal) => {
    debugLog("lane_session_process_exit", {
      laneId: lane.laneId,
      code: code ?? null,
      signal: signal ?? null,
      pendingCount: session.pending.size,
    });
    cleanupLaneSession(lane.laneId, session);
    settleLaneSessionPending(
      session,
      `lane_session_exit:${code ?? "null"}:${signal ?? "null"}`
    );
    if (session.closing) {
      return;
    }
    scheduleLaneBlockedOnSessionExit(lane, code ?? null, signal ?? null);
  });
}

async function initializeLaneSessionIfNeeded(
  lane: Lane,
  session: LaneSession,
  request: (
    method: string,
    params: Record<string, unknown>
  ) => Promise<JsonRpcMessage>,
  send: (payload: Record<string, unknown>) => void,
  waitForThreadResume: boolean,
  emitStartedEvent: boolean
) {
  const init = await request("initialize", {
    ...getCodexInitializePayload(),
  });
  if (init.error) {
    throw new Error(getRpcErrorMessage(init, "initialize failed"));
  }
  send({ method: "initialized", params: {} });

  if (!(waitForThreadResume && lane.threadId)) {
    return;
  }
  if (session.threadId !== lane.threadId) {
    unlinkThreadFromLaneSession(session.threadId, lane.laneId);
  }
  session.threadId = lane.threadId;
  linkThreadToLaneSession(lane.threadId, lane.laneId);
  const ready = await waitForThreadReadiness(lane);
  if (emitStartedEvent) {
    await emitLaneSessionStarted(lane, session, ready);
  }
}

function createLaneSession(lane: Lane): LaneSession {
  const proc = spawn(codexBinary(), ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: proc.stdout });
  return {
    laneId: lane.laneId,
    threadId: lane.threadId,
    proc,
    rl,
    seq: 1,
    pending: new Map(),
    serverRequests: new Map(),
    startedAt: nowIso(),
    readyAt: undefined,
    sessionStartedEventEmitted: false,
    closing: false,
  };
}

async function startLaneSession(
  lane: Lane,
  options: StartLaneSessionOptions = {}
) {
  const waitForThreadResume = options.waitForThreadResume ?? true;
  const emitStartedEvent = options.emitStartedEvent ?? true;
  const reused = await maybeReuseLaneSession(
    lane,
    waitForThreadResume,
    emitStartedEvent
  );
  if (reused) {
    return reused;
  }

  const session = createLaneSession(lane);
  const send = createLaneSessionSend(session, lane);
  const request = createLaneSessionRequest(session, lane, send);

  registerLaneSessionProcessHandlers(session, lane);
  attachLaneSessionLineHandler(session, lane);
  laneSessions.set(lane.laneId, session);

  try {
    await initializeLaneSessionIfNeeded(
      lane,
      session,
      request,
      send,
      waitForThreadResume,
      emitStartedEvent
    );
    return session;
  } catch (error) {
    cleanupLaneSession(lane.laneId, session);
    settleLaneSessionPending(
      session,
      `lane_session_start_failed:${(error as Error).message}`
    );
    session.closing = true;
    try {
      session.rl.close();
    } catch {
      // ignore cleanup errors
    }
    try {
      session.proc.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

function stopLaneSession(laneId: string) {
  const s = laneSessions.get(laneId);
  if (!s) {
    return false;
  }
  s.closing = true;
  try {
    s.proc.kill("SIGTERM");
  } catch {
    // ignore cleanup errors
  }
  try {
    s.rl.close();
  } catch {
    // ignore cleanup errors
  }
  clearThreadLaneMappingsForLane(laneId);
  laneSessions.delete(laneId);
  return true;
}

function laneSessionRespondApproval(
  laneId: string,
  requestId: string | number,
  decision: "approved" | "denied"
) {
  const s = laneSessions.get(laneId);
  if (!s) {
    throw new Error("lane session not running");
  }
  if (!s.serverRequests.has(requestId)) {
    throw new Error("approval request not found in session");
  }
  if (!s.proc.stdin) {
    throw new Error("lane session stdin unavailable");
  }
  s.proc.stdin.write(
    `${JSON.stringify({ id: requestId, result: { decision } })}\n`
  );
  s.serverRequests.delete(requestId);
}

async function collectChangedFiles(repoRoot?: string): Promise<string[]> {
  if (!repoRoot) {
    return [];
  }
  try {
    const out = await Bun.$`git -C ${repoRoot} status --porcelain`.text();
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(GIT_STATUS_PREFIX_REGEX, ""));
  } catch {
    return [];
  }
}

function extractCompletionText(params: Record<string, unknown>): string | null {
  const candidates = [
    params?.summary,
    params?.message,
    params?.output,
    params?.result,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim().slice(0, 2000);
    }
  }
  return null;
}

async function emitLaneCompletion(
  lane: Lane,
  params: Record<string, unknown> = {},
  note?: string
) {
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
    if (!file.endsWith(".json")) {
      continue;
    }
    const text = await readFile(join(laneDir, file), "utf8");
    const lane = JSON.parse(text) as Lane;
    lanes.set(lane.laneId, lane);
    if (!approvals.has(lane.laneId)) {
      approvals.set(lane.laneId, []);
    }
  }

  const eventFiles = await readdir(eventDir).catch(() => [] as string[]);
  for (const file of eventFiles) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    const laneId = file.replace(EVENT_LOG_SUFFIX_REGEX, "");
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
      const parsed = JSON.parse(webhookText) as {
        subscriptions?: WebhookSubscription[];
      };
      for (const sub of parsed.subscriptions ?? []) {
        webhookSubscriptions.set(sub.id, sub);
      }
    } catch {
      // ignore invalid webhook file
    }
  }
}

async function codexRpc(method: string, params: Record<string, unknown> = {}) {
  const proc = spawn(codexBinary(), ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: proc.stdout });

  let seq = 1;
  const pending = new Map<
    number,
    {
      resolve: (msg: JsonRpcMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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

  const send = (payload: Record<string, unknown>) => {
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      throw new Error(`codex_stdin_failed:${(err as Error).message}`);
    }
  };

  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    const out = new Promise<JsonRpcMessage>((resolve, reject) => {
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
      const msg = JSON.parse(line) as JsonRpcMessage;
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
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore cleanup errors
    }
  }, 12_000);

  try {
    const init = await request("initialize", {
      ...getCodexInitializePayload(),
    });
    if (init?.error) {
      throw new Error(init.error?.message ?? "initialize failed");
    }
    send({ method: "initialized", params: {} });

    const res = await request(method, params);
    if (res?.error) {
      throw new Error(res.error?.message ?? `${method} failed`);
    }
    return res?.result ?? {};
  } catch (error) {
    settleAll(error as Error);
    throw error;
  } finally {
    clearTimeout(hardTimer);
    try {
      rl.close();
    } catch {
      // ignore cleanup errors
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
  }
}

async function listCodexThreads(
  limit = 50,
  sourceKinds?: string[]
): Promise<CodexThread[]> {
  const params: Record<string, unknown> = { limit };
  if (sourceKinds?.length) {
    params.sourceKinds = sourceKinds;
  }
  const result = await codexRpc("thread/list", params);
  const data = (result?.data ?? []) as CodexThread[];
  const state = await readCodexGlobalState();
  const base = data.map((t) => ({ ...t, surface: normalizeSurface(t.source) }));
  return await Promise.all(base.map((t) => enrichCodexThread(t, state)));
}

async function getCodexThreadById(
  threadId: string
): Promise<CodexThread | null> {
  try {
    const res = await codexRpc("thread/read", { threadId });
    const thread = (res.thread ?? null) as CodexThread | null;
    if (thread?.id) {
      return await enrichCodexThread({
        ...thread,
        surface: normalizeSurface(thread.source),
      });
    }
  } catch {
    // fallback below
  }
  const threads = await listCodexThreads(300, [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
  ]);
  return threads.find((t) => t.id === threadId) ?? null;
}

function buildRpcPassthroughResponse(message: string, error: unknown) {
  return {
    error: message,
    message: (error as Error).message,
  };
}

async function codexThreadStart(params: Record<string, unknown> = {}) {
  const res = await codexRpc("thread/start", params);
  const t = (res?.thread ?? null) as CodexThread | null;
  return t
    ? await enrichCodexThread({ ...t, surface: normalizeSurface(t.source) })
    : null;
}

async function codexThreadAction(
  method: string,
  threadId: string,
  params: Record<string, unknown> = {}
) {
  const merged = { ...params, threadId };
  const laneId = threadToLaneSession.get(threadId);
  if (laneId) {
    const session = laneSessions.get(laneId);
    if (session) {
      const result = await laneSessionRequest(laneId, method, merged);
      if (!result.error) {
        return result.result ?? {};
      }
      const message = getRpcErrorMessage(result, `${method} failed`);
      if (!isNoRolloutFoundError(message)) {
        throw new Error(message);
      }
      unlinkThreadFromLaneSession(threadId, laneId);
    }
  }
  return await codexRpc(method, merged);
}

async function codexTurnOnThread(
  threadId: string,
  inputText: string,
  mode: "start" | "steer" = "start",
  expectedTurnId?: string
) {
  const proc = spawn(codexBinary(), ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: proc.stdout });

  let seq = 1;
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();
  const notes: JsonRpcMessage[] = [];

  const send = (payload: Record<string, unknown>) =>
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    send({ id, method: m, params: p });
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${m}`)), 12_000);
    });
  };

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
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
      ...getCodexInitializePayload(),
    });
    if (init?.error) {
      throw new Error(init.error?.message ?? "initialize failed");
    }
    send({ method: "initialized", params: {} });

    const resume = await request("thread/resume", { threadId });
    if (resume?.error) {
      throw new Error(resume.error?.message ?? "thread/resume failed");
    }

    const method = mode === "steer" ? "turn/steer" : "turn/start";
    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: inputText }],
    };
    if (mode === "steer" && expectedTurnId) {
      turnParams.expectedTurnId = expectedTurnId;
    }
    const turnRes = await request(method, turnParams);

    await new Promise((r) => setTimeout(r, 1500));
    proc.kill("SIGTERM");

    if (turnRes?.error) {
      throw new Error(turnRes.error?.message ?? `${method} failed`);
    }
    return {
      turn: turnRes.result?.turn ?? null,
      notifications: notes.slice(0, 50),
    };
  } catch (error) {
    proc.kill("SIGTERM");
    throw error;
  }
}

async function codexInterruptThread(threadId: string, turnId?: string) {
  const proc = spawn(codexBinary(), ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: proc.stdout });
  let seq = 1;
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();
  const send = (payload: Record<string, unknown>) =>
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (m: string, p: Record<string, unknown>) => {
    const id = seq++;
    send({ id, method: m, params: p });
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout:${m}`)), 10_000);
    });
  };
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (typeof msg.id === "number" && !msg.method) {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      }
    } catch {
      // ignore parse errors from non-JSON lines
    }
  });

  const init = await request("initialize", {
    ...getCodexInitializePayload(),
  });
  if (init?.error) {
    throw new Error(init.error?.message ?? "initialize failed");
  }
  send({ method: "initialized", params: {} });
  const resume = await request("thread/resume", { threadId });
  if (resume?.error) {
    throw new Error(resume.error?.message ?? "thread/resume failed");
  }
  const out = await request(
    "turn/interrupt",
    turnId ? { threadId, turnId } : { threadId }
  );
  proc.kill("SIGTERM");
  if (out?.error) {
    throw new Error(out.error?.message ?? "turn/interrupt failed");
  }
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
      const m = line.match(PROCESS_LIST_LINE_REGEX);
      return m ? { pid: Number(m[1]), cmd: m[2] } : null;
    })
    .filter((x): x is { pid: number; cmd: string } => !!x)
    .filter((x) =>
      x.cmd.includes(
        "/Applications/Codex.app/Contents/Resources/codex app-server"
      )
    );

  const running: Record<string, unknown>[] = [];

  for (const p of pids) {
    const lsof = await Bun.$`lsof -p ${p.pid}`.text().catch(() => "");
    for (const line of lsof.split("\n")) {
      const m = line.match(LSOF_SESSION_PATH_REGEX);
      if (!m) {
        continue;
      }
      const fd = m[1] ?? "";
      if (!fd.includes("w")) {
        continue;
      }
      const path = m[2] ?? "";
      const idMatch = path.match(THREAD_ID_FROM_SESSION_PATH_REGEX);
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
  for (const r of running) {
    dedup.set(`${r.pid}:${r.path}`, r);
  }
  return [...dedup.values()];
}

let watcherIntervalSec = 15;
let watcherTimer: Timer | null = null;

function shouldSkipWatcherLane(lane: Lane) {
  if (!lane.threadId) {
    return true;
  }
  return ["done", "failed", "interrupted"].includes(lane.status);
}

async function emitWatcherSyncError(lane: Lane, error: Error) {
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: "lane.codex.sync_error",
    ts: nowIso(),
    severity: "warn",
    payload: { message: error.message },
  });
}

async function emitWatcherThreadMissing(lane: Lane) {
  await emitEvent({
    eventId: randomUUID(),
    laneId: lane.laneId,
    type: "lane.codex.thread_missing",
    ts: nowIso(),
    severity: "warn",
    payload: { threadId: lane.threadId },
  });
}

async function emitWatcherActivity(
  lane: Lane,
  threadId: string,
  thread: CodexThread,
  previousUpdatedAt: number,
  updatedAt: number
) {
  attachedThreadLastUpdated.set(threadId, updatedAt);
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
      previousUpdatedAt: previousUpdatedAt || null,
      updatedAt,
      cwd: thread.cwd ?? null,
      source: thread.source ?? null,
      surface: thread.surface ?? "unknown",
      preview: (thread.preview ?? "").slice(0, 280) || null,
    },
  });
}

async function processWatcherLane(lane: Lane) {
  if (!lane.threadId) {
    return;
  }
  let thread: CodexThread | null = null;
  try {
    thread = await getCodexThreadById(lane.threadId);
  } catch (error) {
    await emitWatcherSyncError(lane, error as Error);
    return;
  }
  if (!thread) {
    await emitWatcherThreadMissing(lane);
    return;
  }
  const previousUpdatedAt = attachedThreadLastUpdated.get(lane.threadId) ?? 0;
  const updatedAt = thread.updatedAt ?? 0;
  if (updatedAt <= previousUpdatedAt) {
    return;
  }
  await emitWatcherActivity(
    lane,
    lane.threadId,
    thread,
    previousUpdatedAt,
    updatedAt
  );
}

async function runWatcherTick() {
  for (const lane of lanes.values()) {
    if (shouldSkipWatcherLane(lane)) {
      continue;
    }
    await processWatcherLane(lane);
  }
}

function startWatcher(intervalSec = 15) {
  watcherIntervalSec = Math.max(2, intervalSec);
  if (watcherTimer) {
    clearInterval(watcherTimer);
  }
  watcherTimer = setInterval(() => {
    runWatcherTick().catch(() => null);
  }, watcherIntervalSec * 1000);
}

function stopWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
  }
  watcherTimer = null;
}

let processHandlersAttached = false;
let bridgeRuntimeInitialized = false;

function ensureProcessHandlersAttached() {
  if (processHandlersAttached) {
    return;
  }
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection", reason);
  });
  processHandlersAttached = true;
}

export async function initializeBridgeRuntime() {
  if (bridgeRuntimeInitialized) {
    return;
  }
  ensureProcessHandlersAttached();
  await restoreFromDisk();
  startWatcher(15);
  bridgeRuntimeInitialized = true;
}

function createEventsStreamResponse() {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.add(controller);
      controller.enqueue(
        encoder.encode(
          `event: hello\ndata: ${JSON.stringify({ ok: true, ts: nowIso() })}\n\n`
        )
      );
    },
    cancel() {
      // cleanup all stale references lazily
      for (const c of sseClients) {
        try {
          if (c.desiredSize === null) {
            sseClients.delete(c);
          }
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

function getWatcherState() {
  return {
    running: !!watcherTimer,
    intervalSec: watcherIntervalSec,
  };
}

export const bridgeRuntime = {
  APP_VERSION,
  CODEX_APP_SERVER_VERSION,
  approvals,
  attachedThreadLastUpdated,
  buildRpcPassthroughResponse,
  codexInterruptThread,
  codexRpc,
  codexThreadAction,
  codexThreadStart,
  codexTurnOnThread,
  createEventsStreamResponse,
  debugLog,
  detectRunningCodexSessions,
  dispatchWebhooks,
  emitEvent,
  emitLaneCompletion,
  emitLaneSessionStarted,
  enrichCodexThread,
  getCodexThreadById,
  getLaneOr404,
  getRpcErrorMessage,
  getTurnId,
  getWatcherState,
  laneEvents,
  laneSessionRequest,
  laneSessionRespondApproval,
  laneSessions,
  lanes,
  listCodexThreads,
  normalizeSurface,
  nowIso,
  parseBody,
  persistLane,
  persistWebhooks,
  runWatcherTick,
  setLaneStatus,
  startLaneSession,
  startWatcher,
  stopLaneSession,
  stopWatcher,
  waitForThreadReadiness,
  webhookSubscriptions,
};
