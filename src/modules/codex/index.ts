import { Elysia, t } from "elysia";
import type { CodexThread, Lane } from "../bridge/service";
import { bridgeRuntime as runtime } from "../bridge/service";

const defaultSourceKinds = [
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
];

const codexRpcBody = t.Object({
  method: t.String(),
  params: t.Optional(t.Record(t.String(), t.Any())),
});

const codexThreadsQuery = t.Object({
  limit: t.Optional(t.Numeric()),
  sourceKinds: t.Optional(t.String()),
});

const codexThreadParams = t.Object({
  threadId: t.String(),
});

const codexThreadStartBody = t.Object({
  model: t.Optional(t.String()),
});

const startVisibleBody = t.Object({
  laneId: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  repoRoot: t.Optional(t.String()),
  title: t.Optional(t.String()),
  kickoffPrompt: t.Optional(t.String()),
  threadId: t.Optional(t.String()),
  preferredSurface: t.Optional(
    t.Union([
      t.Literal("mac-app"),
      t.Literal("vscode"),
      t.Literal("cli"),
      t.Literal("any"),
    ])
  ),
  requirePreferredSurface: t.Optional(t.Boolean()),
  model: t.Optional(t.String()),
  acceptanceCriteria: t.Optional(t.Array(t.String())),
  verificationCommands: t.Optional(t.Array(t.String())),
});

const codexTurnParams = t.Object({
  threadId: t.String(),
  action: t.Union([
    t.Literal("start"),
    t.Literal("steer"),
    t.Literal("interrupt"),
  ]),
});

const codexTurnBody = t.Object({
  input: t.Optional(t.String()),
  turnId: t.Optional(t.String()),
  expectedTurnId: t.Optional(t.String()),
});

const codexActiveQuery = t.Object({
  windowSec: t.Optional(t.Numeric()),
  source: t.Optional(t.String()),
  sourceKinds: t.Optional(t.String()),
  surface: t.Optional(t.String()),
  originator: t.Optional(t.String()),
  preferOriginator: t.Optional(t.String()),
  preferredSurface: t.Optional(t.String()),
});

async function runThreadAction({
  threadId,
  operation,
  body,
}: {
  threadId: string;
  operation:
    | "fork"
    | "archive"
    | "unarchive"
    | "rollback"
    | "compact"
    | "compact/start";
  body: Record<string, unknown>;
}) {
  const method =
    operation === "compact"
      ? "thread/compact/start"
      : `thread/${operation === "compact/start" ? "compact/start" : operation}`;
  const result = await runtime.codexThreadAction(method, threadId, body);
  return {
    ok: true,
    method,
    threadId,
    result,
  };
}

type PreferredSurface = NonNullable<Lane["preferredSurface"]>;

interface StartVisibleBodyInput {
  laneId?: string;
  projectId?: string;
  repoRoot?: string;
  title?: string;
  kickoffPrompt?: string;
  threadId?: string;
  preferredSurface?: PreferredSurface;
  requirePreferredSurface?: boolean;
  model?: string;
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
}

interface StartVisibleRequest {
  laneId: string;
  projectId?: string;
  repoRoot?: string;
  title?: string;
  kickoffPrompt?: string;
  takeoverThreadId?: string;
  preferredSurface: PreferredSurface;
  requirePreferredSurface: boolean;
  model?: string;
  acceptanceCriteria: string[];
  verificationCommands: string[];
}

interface StartVisibleThreadResult {
  sessionStartedAt: string;
  thread: CodexThread;
}

interface StartVisibleResult {
  lane: Lane;
  thread: CodexThread;
  turnId: string | null;
}

interface RouteErrorPayload {
  error: string;
  message?: string;
}

class RouteError extends Error {
  statusCode: number;
  payload: RouteErrorPayload;

  constructor(statusCode: number, payload: RouteErrorPayload) {
    super(payload.message ?? payload.error);
    this.name = "RouteError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

const parseOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const getSurfaceFromThread = (
  thread: CodexThread
): NonNullable<Lane["surface"]> =>
  thread.surface ?? runtime.normalizeSurface(thread.source);

const inferProjectIdFromCwd = (cwd?: string): string | undefined =>
  cwd ? cwd.split("/").pop() : undefined;

const parsePreferredSurface = (value: unknown): PreferredSurface => {
  if (
    value === "mac-app" ||
    value === "vscode" ||
    value === "cli" ||
    value === "any"
  ) {
    return value;
  }
  return "any";
};

const parseStartVisibleRequest = ({
  body,
}: {
  body: StartVisibleBodyInput;
}): StartVisibleRequest => ({
  laneId: parseOptionalString(body.laneId) ?? `lane-${crypto.randomUUID()}`,
  projectId: parseOptionalString(body.projectId),
  repoRoot: parseOptionalString(body.repoRoot),
  title: parseOptionalString(body.title),
  kickoffPrompt: parseOptionalString(body.kickoffPrompt),
  takeoverThreadId: parseOptionalString(body.threadId),
  preferredSurface: parsePreferredSurface(body.preferredSurface),
  requirePreferredSurface: body.requirePreferredSurface === true,
  model: parseOptionalString(body.model),
  acceptanceCriteria: body.acceptanceCriteria ?? [],
  verificationCommands: body.verificationCommands ?? [],
});

const createVisibleLane = ({
  request,
  takeoverThread,
}: {
  request: StartVisibleRequest;
  takeoverThread: CodexThread | null;
}): Lane => {
  const now = runtime.nowIso();
  return {
    laneId: request.laneId,
    projectId: request.projectId,
    repoRoot: request.repoRoot,
    threadId: request.takeoverThreadId,
    activeTurnId: undefined,
    preferredSurface: request.preferredSurface,
    surface: takeoverThread ? getSurfaceFromThread(takeoverThread) : "unknown",
    status: "starting",
    acceptanceCriteria: request.acceptanceCriteria,
    verificationCommands: request.verificationCommands,
    createdAt: now,
    updatedAt: now,
  };
};

async function resolveTakeoverThread({
  request,
}: {
  request: StartVisibleRequest;
}): Promise<CodexThread | null> {
  if (!request.takeoverThreadId) {
    return null;
  }

  let takeoverThread: CodexThread | null = null;
  try {
    takeoverThread = await runtime.getCodexThreadById(request.takeoverThreadId);
  } catch {
    throw new RouteError(502, {
      error: "codex_rpc_failed",
      message: "failed to read thread",
    });
  }

  if (!takeoverThread) {
    throw new RouteError(404, { error: "thread_not_found" });
  }

  const takeoverSurface = getSurfaceFromThread(takeoverThread);
  if (
    request.requirePreferredSurface &&
    request.preferredSurface !== "any" &&
    takeoverSurface !== request.preferredSurface
  ) {
    throw new RouteError(409, {
      error: "surface_mismatch",
      message: `thread surface ${takeoverSurface} does not match preferredSurface ${request.preferredSurface}`,
    });
  }

  return takeoverThread;
}

async function initializeVisibleLane({
  lane,
  request,
  takeoverThread,
}: {
  lane: Lane;
  request: StartVisibleRequest;
  takeoverThread: CodexThread | null;
}) {
  runtime.lanes.set(lane.laneId, lane);
  runtime.approvals.set(lane.laneId, []);
  await runtime.persistLane(lane);
  await runtime.emitEvent({
    eventId: crypto.randomUUID(),
    laneId: lane.laneId,
    type: "lane.started.visible_workflow",
    ts: lane.createdAt,
    severity: "info",
    payload: {
      threadId: request.takeoverThreadId ?? null,
      source: null,
      surface: takeoverThread
        ? getSurfaceFromThread(takeoverThread)
        : "unknown",
      title: request.title ?? null,
      preferredSurface: request.preferredSurface,
      requirePreferredSurface: request.requirePreferredSurface,
    },
  });
}

const syncLaneFromThread = ({
  lane,
  thread,
  projectId,
  repoRoot,
}: {
  lane: Lane;
  thread: CodexThread;
  projectId?: string;
  repoRoot?: string;
}) => {
  lane.repoRoot = repoRoot ?? thread.cwd;
  lane.projectId = projectId ?? inferProjectIdFromCwd(thread.cwd);
  lane.surface = getSurfaceFromThread(thread);
  lane.updatedAt = runtime.nowIso();
  runtime.attachedThreadLastUpdated.set(thread.id, thread.updatedAt ?? 0);
};

async function startVisibleThread({
  lane,
  request,
}: {
  lane: Lane;
  request: StartVisibleRequest;
}): Promise<CodexThread> {
  const startResponse = await runtime.laneSessionRequest(
    lane.laneId,
    "thread/start",
    {
      model: request.model,
      cwd: request.repoRoot,
    }
  );
  if (startResponse.error) {
    throw new Error(
      runtime.getRpcErrorMessage(startResponse, "thread/start failed")
    );
  }

  const startedThread = (startResponse.result?.thread ??
    null) as CodexThread | null;
  if (!startedThread?.id) {
    throw new Error("thread/start returned no thread id");
  }

  return await runtime.enrichCodexThread({
    ...startedThread,
    surface: runtime.normalizeSurface(startedThread.source),
  });
}

async function ensureVisibleThreadReady({
  lane,
  request,
  takeoverThread,
}: {
  lane: Lane;
  request: StartVisibleRequest;
  takeoverThread: CodexThread | null;
}): Promise<StartVisibleThreadResult> {
  const session = await runtime.startLaneSession(lane, {
    waitForThreadResume: !takeoverThread,
    emitStartedEvent: false,
  });

  const thread =
    takeoverThread ?? (await startVisibleThread({ lane, request }));
  if (!takeoverThread) {
    lane.threadId = thread.id;
    session.threadId = thread.id;
  }

  syncLaneFromThread({
    lane,
    thread,
    projectId: request.projectId,
    repoRoot: request.repoRoot,
  });
  await runtime.persistLane(lane);
  const ready = await runtime.waitForThreadReadiness(lane, 10, true);
  await runtime.emitLaneSessionStarted(lane, session, ready);
  return {
    sessionStartedAt: session.startedAt,
    thread,
  };
}

async function maybeSetVisibleThreadTitle({
  lane,
  thread,
  title,
}: {
  lane: Lane;
  thread: CodexThread;
  title?: string;
}) {
  if (!title) {
    return;
  }

  const nameResponse = await runtime.laneSessionRequest(
    lane.laneId,
    "thread/name/set",
    {
      threadId: thread.id,
      name: title,
    }
  );
  if (nameResponse.error) {
    throw new Error(
      runtime.getRpcErrorMessage(nameResponse, "thread/name/set failed")
    );
  }
}

async function maybeStartVisibleKickoffTurn({
  lane,
  thread,
  kickoffPrompt,
}: {
  lane: Lane;
  thread: CodexThread;
  kickoffPrompt?: string;
}): Promise<string | null> {
  if (!kickoffPrompt) {
    return null;
  }

  const turnResponse = await runtime.laneSessionRequest(
    lane.laneId,
    "turn/start",
    {
      threadId: thread.id,
      input: [{ type: "text", text: kickoffPrompt }],
    }
  );
  if (turnResponse.error) {
    throw new Error(
      runtime.getRpcErrorMessage(turnResponse, "turn/start failed")
    );
  }

  const turnId = runtime.getTurnId(turnResponse.result);
  if (typeof turnId === "string") {
    lane.activeTurnId = turnId;
    return turnId;
  }
  return null;
}

async function runStartVisibleWorkflow({
  lane,
  request,
  takeoverThread,
}: {
  lane: Lane;
  request: StartVisibleRequest;
  takeoverThread: CodexThread | null;
}): Promise<StartVisibleResult> {
  runtime.debugLog("start-visible:entered", { laneId: lane.laneId });

  const { thread, sessionStartedAt } = await ensureVisibleThreadReady({
    lane,
    request,
    takeoverThread,
  });
  await maybeSetVisibleThreadTitle({
    lane,
    thread,
    title: request.title,
  });

  const turnId = await maybeStartVisibleKickoffTurn({
    lane,
    thread,
    kickoffPrompt: request.kickoffPrompt,
  });

  lane.updatedAt = runtime.nowIso();
  await runtime.persistLane(lane);
  await runtime.setLaneStatus(lane, "running", "lane.running", {
    threadId: lane.threadId,
    turnId,
    sessionStartedAt,
  });

  return {
    lane,
    thread,
    turnId,
  };
}

export const codexModule = new Elysia({ name: "codex-module" })
  .post(
    "/codex/rpc",
    async ({ body, status }) => {
      const rpcMethod = String(body.method ?? "").trim();
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (!rpcMethod) {
        return status(400, { error: "method_required" });
      }
      try {
        const result = await runtime.codexRpc(rpcMethod, params);
        return { method: rpcMethod, result };
      } catch (error) {
        return status(
          502,
          runtime.buildRpcPassthroughResponse("codex_rpc_failed", error)
        );
      }
    },
    {
      detail: {
        summary: "Raw Codex JSON-RPC passthrough",
        tags: ["codex"],
      },
      body: codexRpcBody,
    }
  )
  .get(
    "/codex/app/list",
    async ({ status }) => {
      try {
        const result = await runtime.codexRpc("app/list");
        return { method: "app/list", result };
      } catch (error) {
        return status(
          502,
          runtime.buildRpcPassthroughResponse("codex_rpc_failed", error)
        );
      }
    },
    {
      detail: {
        summary: "List Codex apps",
        tags: ["codex"],
      },
    }
  )
  .get(
    "/codex/skills/list",
    async ({ status }) => {
      try {
        const result = await runtime.codexRpc("skills/list");
        return { method: "skills/list", result };
      } catch (error) {
        return status(
          502,
          runtime.buildRpcPassthroughResponse("codex_rpc_failed", error)
        );
      }
    },
    {
      detail: {
        summary: "List Codex skills",
        tags: ["codex"],
      },
    }
  )
  .get(
    "/codex/model/list",
    async ({ status }) => {
      try {
        const result = await runtime.codexRpc("model/list");
        return { method: "model/list", result };
      } catch (error) {
        return status(
          502,
          runtime.buildRpcPassthroughResponse("codex_rpc_failed", error)
        );
      }
    },
    {
      detail: {
        summary: "List Codex models",
        tags: ["codex"],
      },
    }
  )
  .get(
    "/codex/threads",
    async ({ query, status }) => {
      const limit = Number(query.limit ?? 50);
      const sourceKinds = String(query.sourceKinds ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      try {
        const threads = await runtime.listCodexThreads(
          Math.max(1, Math.min(limit, 200)),
          sourceKinds.length > 0 ? sourceKinds : defaultSourceKinds
        );
        return { threads, count: threads.length };
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "List Codex threads",
        tags: ["codex"],
      },
      query: codexThreadsQuery,
    }
  )
  .post(
    "/codex/threads/:threadId/fork",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "fork",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/fork",
        });
      }
    },
    {
      detail: {
        summary: "Fork a thread",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .post(
    "/codex/threads/:threadId/archive",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "archive",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/archive",
        });
      }
    },
    {
      detail: {
        summary: "Archive a thread",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .post(
    "/codex/threads/:threadId/unarchive",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "unarchive",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/unarchive",
        });
      }
    },
    {
      detail: {
        summary: "Unarchive a thread",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .post(
    "/codex/threads/:threadId/rollback",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "rollback",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/rollback",
        });
      }
    },
    {
      detail: {
        summary: "Rollback a thread",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .post(
    "/codex/threads/:threadId/compact/start",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "compact/start",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/compact/start",
        });
      }
    },
    {
      detail: {
        summary: "Start thread compaction",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .post(
    "/codex/threads/:threadId/compact",
    async ({ params, body, status }) => {
      try {
        return await runThreadAction({
          threadId: params.threadId,
          operation: "compact",
          body: (body as Record<string, unknown>) ?? {},
        });
      } catch (error) {
        return status(502, {
          error: "codex_thread_action_failed",
          message: (error as Error).message,
          threadId: params.threadId,
          method: "thread/compact/start",
        });
      }
    },
    {
      detail: {
        summary: "Alias for starting thread compaction",
        tags: ["codex"],
      },
      params: codexThreadParams,
      body: t.Optional(t.Record(t.String(), t.Any())),
    }
  )
  .get(
    "/codex/threads/loaded",
    async ({ status }) => {
      try {
        const result = await runtime.codexRpc("thread/loaded/list");
        const threadIds = (result?.data ?? []) as string[];
        return { threadIds };
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "List loaded thread IDs",
        tags: ["codex"],
      },
    }
  )
  .get(
    "/codex/threads/:threadId",
    async ({ params, status }) => {
      try {
        const thread = await runtime.getCodexThreadById(params.threadId);
        if (!thread) {
          return status(404, { error: "thread_not_found" });
        }
        return { thread };
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Get thread details",
        tags: ["codex"],
      },
      params: codexThreadParams,
    }
  )
  .post(
    "/codex/threads/start",
    async ({ body, status }) => {
      try {
        const thread = await runtime.codexThreadStart({
          model: body.model as string | undefined,
        });
        if (!thread) {
          return status(502, { error: "thread_start_failed" });
        }
        return status(201, { thread });
      } catch (error) {
        return status(502, {
          error: "codex_thread_start_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Start a new Codex thread",
        tags: ["codex"],
      },
      body: codexThreadStartBody,
    }
  )
  .post(
    "/codex/workflows/start-visible",
    async ({ body, status }) => {
      runtime.debugLog("route_hit", {
        route: "/codex/workflows/start-visible",
      });

      const request = parseStartVisibleRequest({
        body: body as StartVisibleBodyInput,
      });
      if (runtime.lanes.has(request.laneId)) {
        return status(409, { error: "lane_exists" });
      }

      try {
        const takeoverThread = await resolveTakeoverThread({ request });
        const lane = createVisibleLane({
          request,
          takeoverThread,
        });
        await initializeVisibleLane({
          lane,
          request,
          takeoverThread,
        });

        try {
          const result = await runStartVisibleWorkflow({
            lane,
            request,
            takeoverThread,
          });
          return status(201, result);
        } catch (error) {
          const message = (error as Error).message;
          await runtime.setLaneStatus(lane, "blocked", "lane.session.blocked", {
            reason: message,
            threadId: lane.threadId ?? null,
          });
          runtime.stopLaneSession(lane.laneId);
          return status(502, {
            error: "visible_workflow_failed",
            message,
            laneId: lane.laneId,
            threadId: lane.threadId ?? null,
          });
        }
      } catch (error) {
        if (error instanceof RouteError) {
          return status(error.statusCode, error.payload);
        }
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Start or take over a visible workflow lane",
        tags: ["codex", "lanes"],
      },
      body: startVisibleBody,
    }
  )
  .post(
    "/codex/threads/:threadId/turns/:action",
    async ({ params, body, status }) => {
      try {
        if (params.action === "interrupt") {
          const result = await runtime.codexInterruptThread(
            params.threadId,
            body.turnId ? String(body.turnId) : undefined
          );
          return { ok: true, result };
        }

        const input = String(body.input ?? "").trim();
        if (!input) {
          return status(400, { error: "input_required" });
        }

        const result = await runtime.codexTurnOnThread(
          params.threadId,
          input,
          params.action === "steer" ? "steer" : "start",
          body.expectedTurnId ? String(body.expectedTurnId) : undefined
        );

        return { ok: true, result };
      } catch (error) {
        return status(502, {
          error: "codex_turn_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Start, steer, or interrupt a turn on a thread",
        tags: ["codex", "turns"],
      },
      params: codexTurnParams,
      body: codexTurnBody,
    }
  )
  .get(
    "/codex/active",
    async ({ query, status }) => {
      const windowSec = Number(query.windowSec ?? 300);
      try {
        const source = query.source;
        const sourceKinds = String(query.sourceKinds ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        const surface = String(query.surface ?? "").trim();
        const originator = String(query.originator ?? "").trim();
        const preferOriginator = String(query.preferOriginator ?? "").trim();
        const preferredSurface = String(query.preferredSurface ?? "any").trim();

        const threads = await runtime.listCodexThreads(
          200,
          sourceKinds.length > 0 ? sourceKinds : defaultSourceKinds
        );
        const now = Math.floor(Date.now() / 1000);

        let active = threads.filter(
          (thread) =>
            typeof thread.updatedAt === "number" &&
            now - thread.updatedAt <= windowSec &&
            (!source || thread.source === source) &&
            (!surface || thread.surface === surface) &&
            (!originator || thread.originator === originator)
        );
        active.sort(
          (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
        );

        if (preferOriginator) {
          const preferredByOrigin = active.filter(
            (thread) => thread.originator === preferOriginator
          );
          if (preferredByOrigin.length > 0) {
            active = preferredByOrigin;
          }
        }

        if (preferredSurface && preferredSurface !== "any") {
          const preferredBySurface = active.filter(
            (thread) => thread.surface === preferredSurface
          );
          if (preferredBySurface.length > 0) {
            active = preferredBySurface;
          }
        }

        return {
          windowSec,
          source: source ?? null,
          sourceKinds,
          surface: surface || null,
          originator: originator || null,
          preferOriginator: preferOriginator || null,
          preferredSurface,
          count: active.length,
          threads: active,
        };
      } catch (error) {
        return status(502, {
          error: "codex_active_detect_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Detect active Codex threads",
        tags: ["codex"],
      },
      query: codexActiveQuery,
    }
  )
  .get(
    "/codex/running",
    async ({ status }) => {
      try {
        const sessions = await runtime.detectRunningCodexSessions();
        return { sessions, count: sessions.length };
      } catch (error) {
        return status(502, {
          error: "codex_running_detect_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Detect running app-server processes",
        tags: ["codex"],
      },
    }
  );
