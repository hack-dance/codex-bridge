import { Elysia, t } from "elysia";
import type { CodexThread, Lane } from "../bridge/service";
import { bridgeRuntime as runtime } from "../bridge/service";

const laneIdParams = t.Object({
  laneId: t.String(),
});

const laneSessionParams = t.Object({
  laneId: t.String(),
});

const laneActionParams = t.Object({
  laneId: t.String(),
  action: t.Union([
    t.Literal("prompt"),
    t.Literal("steer"),
    t.Literal("interrupt"),
  ]),
});

const laneApprovalParams = t.Object({
  laneId: t.String(),
  approvalId: t.String(),
  action: t.Union([t.Literal("approve"), t.Literal("deny")]),
});

const lanesAttachBody = t.Object({
  threadId: t.String(),
  laneId: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  repoRoot: t.Optional(t.String()),
  nodeId: t.Optional(t.String()),
  worktreePath: t.Optional(t.String()),
  branch: t.Optional(t.String()),
  preferredSurface: t.Optional(
    t.Union([
      t.Literal("mac-app"),
      t.Literal("vscode"),
      t.Literal("cli"),
      t.Literal("any"),
    ])
  ),
  requirePreferredSurface: t.Optional(t.Boolean()),
  readinessMode: t.Optional(
    t.Union([t.Literal("strict"), t.Literal("lenient")])
  ),
  acceptanceCriteria: t.Optional(t.Array(t.String())),
  verificationCommands: t.Optional(t.Array(t.String())),
});

const lanesCreateBody = t.Object({
  laneId: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  repoRoot: t.Optional(t.String()),
  nodeId: t.Optional(t.String()),
  worktreePath: t.Optional(t.String()),
  branch: t.Optional(t.String()),
  threadId: t.Optional(t.String()),
  readinessMode: t.Optional(
    t.Union([t.Literal("strict"), t.Literal("lenient")])
  ),
  acceptanceCriteria: t.Optional(t.Array(t.String())),
  verificationCommands: t.Optional(t.Array(t.String())),
});

const lanePromptBody = t.Object({
  input: t.Optional(t.String()),
});

const laneCleanupBody = t.Object({
  statuses: t.Optional(t.Array(t.String())),
  olderThanHours: t.Optional(t.Numeric()),
  syntheticOnly: t.Optional(t.Boolean()),
  limit: t.Optional(t.Numeric()),
  dryRun: t.Optional(t.Boolean()),
});

const lanePreferredSurfaceBody = t.Optional(
  t.Union([
    t.Literal("mac-app"),
    t.Literal("vscode"),
    t.Literal("cli"),
    t.Literal("any"),
  ])
);

const laneSyncBody = t.Optional(
  t.Object({
    threadId: t.Optional(t.String()),
    preferredSurface: lanePreferredSurfaceBody,
    requirePreferredSurface: t.Optional(t.Boolean()),
  })
);

const laneSessionStartBody = t.Optional(
  t.Object({
    threadId: t.Optional(t.String()),
    readinessMode: t.Optional(
      t.Union([t.Literal("strict"), t.Literal("lenient")])
    ),
    preferredSurface: lanePreferredSurfaceBody,
    requirePreferredSurface: t.Optional(t.Boolean()),
    waitForThreadResume: t.Optional(t.Boolean()),
  })
);

type LaneAction = "prompt" | "steer" | "interrupt";

interface LaneActionBodyInput {
  input?: string;
}

interface LaneActionPayload {
  laneId: string;
  action: LaneAction;
}

interface LaneActionErrorPayload {
  error: string;
  message?: string;
}

const knownLaneStatuses = new Set<string>([
  "idle",
  "starting",
  "running",
  "needs_approval",
  "blocked",
  "verifying",
  "done",
  "failed",
  "interrupted",
]);

class LaneActionError extends Error {
  statusCode: number;
  payload: LaneActionErrorPayload;

  constructor(statusCode: number, payload: LaneActionErrorPayload) {
    super(payload.message ?? payload.error);
    this.name = "LaneActionError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

const laneTurnEventType = (
  action: LaneAction
): "lane.turn.started" | "lane.turn.steered" =>
  action === "prompt" ? "lane.turn.started" : "lane.turn.steered";

const parseLaneInput = ({ body }: { body: LaneActionBodyInput }): string =>
  String(body.input ?? "").trim();

const requireLaneInput = ({ input }: { input: string }) => {
  if (!input) {
    throw new LaneActionError(400, { error: "input_required" });
  }
};

const requireActiveTurnId = ({
  lane,
  action,
}: {
  lane: Lane;
  action: "steer" | "interrupt";
}): string => {
  if (!lane.activeTurnId) {
    if (action === "steer") {
      throw new LaneActionError(409, {
        error: "no_active_turn",
        message: "steer requires an active turn",
      });
    }
    throw new LaneActionError(409, { error: "no_active_turn" });
  }
  return lane.activeTurnId;
};

const getLaneReadinessMode = ({ lane }: { lane: Lane }): "strict" | "lenient" =>
  lane.readinessMode ?? "lenient";

const parseAttachPreferredSurface = ({
  value,
}: {
  value: unknown;
}): "mac-app" | "vscode" | "cli" | "any" =>
  value === "mac-app" ||
  value === "vscode" ||
  value === "cli" ||
  value === "any"
    ? value
    : "any";

const isSurfaceMismatch = ({
  requirePreferredSurface,
  preferredSurface,
  detectedSurface,
}: {
  requirePreferredSurface: boolean;
  preferredSurface: "mac-app" | "vscode" | "cli" | "any";
  detectedSurface: "mac-app" | "vscode" | "cli" | "unknown";
}): boolean =>
  requirePreferredSurface &&
  preferredSurface !== "any" &&
  detectedSurface !== preferredSurface;

const parseCleanupStatuses = ({
  statuses,
}: {
  statuses?: string[];
}): string[] => {
  if (!statuses) {
    return [];
  }
  return statuses
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && knownLaneStatuses.has(value));
};

const laneUpdatedAtMs = ({ lane }: { lane: Lane }): number => {
  const parsed = Date.parse(lane.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

async function requestLaneTurnStart({
  payload,
  lane,
  input,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  input: string;
}) {
  const result = await runtime.laneSessionRequestWithRetry(
    payload.laneId,
    "turn/start",
    {
      threadId: lane.threadId,
      input: [{ type: "text", text: input }],
    },
    {
      maxAttempts: 5,
      initialBackoffMs: 200,
      retryOnNoRollout: true,
    }
  );
  if (result?.error) {
    throw new Error(result.error?.message ?? "turn/start failed");
  }
  const turnId = runtime.getTurnId(result.result);
  if (turnId) {
    lane.activeTurnId = turnId;
  }
}

async function requestLaneTurnSteer({
  payload,
  lane,
  input,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  input: string;
}) {
  const activeTurnId = requireActiveTurnId({ lane, action: "steer" });
  const result = await runtime.laneSessionRequestWithRetry(
    payload.laneId,
    "turn/steer",
    {
      threadId: lane.threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: input }],
    },
    {
      maxAttempts: 5,
      initialBackoffMs: 200,
      retryOnNoRollout: true,
    }
  );
  if (result?.error) {
    throw new Error(result.error?.message ?? "turn/steer failed");
  }
}

async function requestLaneTurnInterrupt({
  payload,
  lane,
}: {
  payload: LaneActionPayload;
  lane: Lane;
}) {
  const activeTurnId = requireActiveTurnId({ lane, action: "interrupt" });
  const result = await runtime.laneSessionRequestWithRetry(
    payload.laneId,
    "turn/interrupt",
    {
      threadId: lane.threadId,
      turnId: activeTurnId,
    },
    {
      maxAttempts: 4,
      initialBackoffMs: 150,
      retryOnNoRollout: true,
    }
  );
  if (result?.error) {
    throw new Error(result.error?.message ?? "turn/interrupt failed");
  }
  await runtime.setLaneStatus(lane, "interrupted", "lane.interrupted", {
    threadId: lane.threadId,
    turnId: activeTurnId,
  });
  lane.activeTurnId = undefined;
  await runtime.persistLane(lane);
}

async function emitThreadedLaneTurnEvent({
  payload,
  lane,
  input,
  sessionStartedAt,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  input: string;
  sessionStartedAt: string;
}) {
  await runtime.emitEvent({
    eventId: crypto.randomUUID(),
    laneId: payload.laneId,
    type: laneTurnEventType(payload.action),
    ts: runtime.nowIso(),
    severity: "info",
    payload: {
      input,
      threadId: lane.threadId,
      turnId: lane.activeTurnId ?? null,
      sessionStartedAt,
    },
  });
}

async function runThreadedLaneAction({
  payload,
  lane,
  body,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  body: LaneActionBodyInput;
}) {
  const session =
    runtime.laneSessions.get(payload.laneId) ??
    (await runtime.startLaneSession(lane));
  if (
    getLaneReadinessMode({ lane }) === "strict" &&
    session.readinessDeferred
  ) {
    throw new LaneActionError(409, {
      error: "lane_readiness_deferred",
      message:
        session.readinessReason ??
        "strict readiness mode blocks turns until thread resume succeeds",
    });
  }
  if (payload.action === "interrupt") {
    await requestLaneTurnInterrupt({ payload, lane });
    return;
  }

  const input = parseLaneInput({ body });
  requireLaneInput({ input });
  if (payload.action === "steer") {
    await requestLaneTurnSteer({ payload, lane, input });
  } else {
    await requestLaneTurnStart({ payload, lane, input });
  }

  lane.updatedAt = runtime.nowIso();
  await runtime.persistLane(lane);
  await emitThreadedLaneTurnEvent({
    payload,
    lane,
    input,
    sessionStartedAt: session.startedAt,
  });
}

async function runUnattachedLaneAction({
  payload,
  lane,
  body,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  body: LaneActionBodyInput;
}) {
  if (payload.action === "interrupt") {
    await runtime.setLaneStatus(lane, "interrupted", "lane.interrupted");
    return;
  }

  await runtime.emitEvent({
    eventId: crypto.randomUUID(),
    laneId: payload.laneId,
    type: laneTurnEventType(payload.action),
    ts: runtime.nowIso(),
    severity: "info",
    payload: { input: body.input ?? null },
  });
}

async function emitLaneTurnFailure({
  payload,
  lane,
  errorMessage,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  errorMessage: string;
}) {
  await runtime.emitEvent({
    eventId: crypto.randomUUID(),
    laneId: payload.laneId,
    type: "lane.turn.failed",
    ts: runtime.nowIso(),
    severity: "error",
    payload: {
      message: errorMessage,
      action: payload.action,
      threadId: lane.threadId,
    },
  });
}

export const lanesModule = new Elysia({ name: "lanes-module" })
  .get("/lanes", () => ({ lanes: [...runtime.lanes.values()] }), {
    detail: {
      summary: "List lanes",
      tags: ["lanes"],
    },
  })
  .get(
    "/lanes/sessions",
    () => {
      const sessions = [...runtime.lanes.values()].map((lane) => {
        const session = runtime.laneSessions.get(lane.laneId);
        return {
          laneId: lane.laneId,
          threadId: lane.threadId ?? null,
          running: !!session,
          startedAt: session?.startedAt ?? null,
          pendingRequests: session ? session.serverRequests.size : 0,
          activeTurnId: lane.activeTurnId ?? null,
          readinessMode: lane.readinessMode ?? "lenient",
          readinessDeferred: session?.readinessDeferred ?? false,
          readinessReason: session?.readinessReason ?? null,
        };
      });
      return {
        sessions,
        count: sessions.length,
        runningCount: sessions.filter((entry) => entry.running).length,
      };
    },
    {
      detail: {
        summary: "List lane session states",
        tags: ["lanes", "sessions"],
      },
    }
  )
  .post(
    "/lanes/cleanup",
    async ({ body }) => {
      const dryRun = body.dryRun === true;
      const syntheticOnly = body.syntheticOnly === true;
      const olderThanHours = Math.max(0, Number(body.olderThanHours ?? 24));
      const olderThanMs = olderThanHours * 60 * 60 * 1000;
      const nowMs = Date.now();
      const limit = Math.max(1, Math.min(500, Number(body.limit ?? 100)));
      const statuses = parseCleanupStatuses({
        statuses: body.statuses?.map((value) => String(value)),
      });

      const selected = [...runtime.lanes.values()]
        .filter(
          (lane) => statuses.length === 0 || statuses.includes(lane.status)
        )
        .filter((lane) => {
          if (!syntheticOnly) {
            return true;
          }
          return lane.threadId
            ? runtime.isSyntheticThreadId(lane.threadId)
            : false;
        })
        .filter((lane) => nowMs - laneUpdatedAtMs({ lane }) >= olderThanMs)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(0, limit);

      const targetLanes = selected.map((lane) => ({
        laneId: lane.laneId,
        status: lane.status,
        threadId: lane.threadId ?? null,
        updatedAt: lane.updatedAt,
      }));

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          count: targetLanes.length,
          targetLanes,
        };
      }

      const deleted: typeof targetLanes = [];
      const failed: Array<{ laneId: string; error: string }> = [];

      for (const lane of selected) {
        const result = await runtime.deleteLane(lane.laneId);
        if (result.ok) {
          deleted.push({
            laneId: lane.laneId,
            status: lane.status,
            threadId: lane.threadId ?? null,
            updatedAt: lane.updatedAt,
          });
        } else {
          failed.push({
            laneId: lane.laneId,
            error: result.error,
          });
        }
      }

      return {
        ok: true,
        dryRun: false,
        count: deleted.length,
        deleted,
        failed,
      };
    },
    {
      detail: {
        summary: "Bulk cleanup lanes by age and status",
        tags: ["lanes", "maintenance"],
      },
      body: laneCleanupBody,
    }
  )
  .post(
    "/lanes/attach",
    async ({ body, status }) => {
      const threadId = String(body.threadId ?? "");
      if (!threadId) {
        return status(400, { error: "thread_id_required" });
      }

      let thread: CodexThread | null = null;
      try {
        thread = await runtime.getCodexThreadById(threadId);
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }

      if (!thread) {
        return status(404, { error: "thread_not_found" });
      }

      const preferredSurface = parseAttachPreferredSurface({
        value: body.preferredSurface,
      });
      const requirePreferredSurface =
        body.requirePreferredSurface === undefined
          ? false
          : Boolean(body.requirePreferredSurface);
      const detectedSurface =
        thread.surface ?? runtime.normalizeSurface(thread.source);

      if (
        isSurfaceMismatch({
          requirePreferredSurface,
          preferredSurface,
          detectedSurface,
        })
      ) {
        return status(409, {
          error: "surface_mismatch",
          message: `thread surface ${detectedSurface} does not match preferredSurface ${preferredSurface}`,
        });
      }

      const laneId = String(body.laneId ?? `lane-${crypto.randomUUID()}`);
      if (runtime.lanes.has(laneId)) {
        return status(409, { error: "lane_exists" });
      }

      const now = runtime.nowIso();
      const lane: Lane = {
        laneId,
        projectId:
          body.projectId ??
          (thread.cwd ? thread.cwd.split("/").pop() : undefined),
        repoRoot: body.repoRoot ?? thread.cwd,
        nodeId: body.nodeId,
        worktreePath: body.worktreePath,
        branch: body.branch,
        threadId,
        activeTurnId: undefined,
        readinessMode: body.readinessMode ?? "lenient",
        preferredSurface,
        surface: detectedSurface,
        status: "running" as const,
        acceptanceCriteria: body.acceptanceCriteria ?? [],
        verificationCommands: body.verificationCommands ?? [],
        createdAt: now,
        updatedAt: now,
      };

      runtime.lanes.set(laneId, lane);
      runtime.approvals.set(laneId, []);
      runtime.attachedThreadLastUpdated.set(threadId, thread.updatedAt ?? 0);
      await runtime.persistLane(lane);

      await runtime.emitEvent({
        eventId: crypto.randomUUID(),
        laneId,
        type: "lane.attached",
        ts: now,
        severity: "info",
        payload: {
          threadId,
          cwd: thread.cwd ?? null,
          source: thread.source ?? null,
          surface: thread.surface ?? "unknown",
        },
      });

      return status(201, { lane, thread });
    },
    {
      detail: {
        summary: "Attach lane to existing thread",
        tags: ["lanes"],
      },
      body: lanesAttachBody,
    }
  )
  .post(
    "/lanes",
    async ({ body, status }) => {
      const laneId = String(body.laneId ?? `lane-${crypto.randomUUID()}`);
      if (runtime.lanes.has(laneId)) {
        return status(409, { error: "lane_exists" });
      }
      const now = runtime.nowIso();
      const lane: Lane = {
        laneId,
        projectId: body.projectId,
        repoRoot: body.repoRoot,
        nodeId: body.nodeId,
        worktreePath: body.worktreePath,
        branch: body.branch,
        threadId: body.threadId,
        activeTurnId: undefined,
        readinessMode: body.readinessMode ?? "lenient",
        status: "starting" as const,
        acceptanceCriteria: body.acceptanceCriteria ?? [],
        verificationCommands: body.verificationCommands ?? [],
        createdAt: now,
        updatedAt: now,
      };

      runtime.lanes.set(laneId, lane);
      runtime.approvals.set(laneId, []);
      await runtime.persistLane(lane);
      await runtime.emitEvent({
        eventId: crypto.randomUUID(),
        laneId,
        type: "lane.started",
        ts: now,
        severity: "info",
      });
      await runtime.setLaneStatus(lane, "running", "lane.running");
      return status(201, { lane });
    },
    {
      detail: {
        summary: "Create lane",
        tags: ["lanes"],
      },
      body: lanesCreateBody,
    }
  )
  .post(
    "/lanes/:laneId/sync-from-codex",
    async ({ params, body, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }

      const syncBody = (body ?? {}) as {
        threadId?: string;
        preferredSurface?: "mac-app" | "vscode" | "cli" | "any";
        requirePreferredSurface?: boolean;
      };
      const requestedThreadId = String(syncBody.threadId ?? "").trim();
      const effectiveThreadId = requestedThreadId || lane.threadId;
      if (!effectiveThreadId) {
        return status(400, {
          error: "lane_not_attached",
          message:
            "sync requires lane threadId; provide threadId in request body",
        });
      }

      const preferredSurface =
        syncBody.preferredSurface !== undefined
          ? parseAttachPreferredSurface({ value: syncBody.preferredSurface })
          : lane.preferredSurface ?? "any";
      const requirePreferredSurface = syncBody.requirePreferredSurface === true;

      let thread: CodexThread | null = null;
      try {
        thread = await runtime.getCodexThreadById(effectiveThreadId);
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
      if (!thread) {
        return status(404, { error: "thread_not_found" });
      }

      const detectedSurface =
        thread.surface ?? runtime.normalizeSurface(thread.source);
      if (
        isSurfaceMismatch({
          requirePreferredSurface,
          preferredSurface,
          detectedSurface,
        })
      ) {
        return status(409, {
          error: "surface_mismatch",
          message: `thread surface ${detectedSurface} does not match preferredSurface ${preferredSurface}`,
        });
      }

      lane.threadId = effectiveThreadId;
      lane.repoRoot = thread.cwd ?? lane.repoRoot;
      lane.surface = detectedSurface;
      if (syncBody.preferredSurface !== undefined) {
        lane.preferredSurface = preferredSurface;
      }
      lane.updatedAt = runtime.nowIso();
      runtime.attachedThreadLastUpdated.set(
        effectiveThreadId,
        thread.updatedAt ?? 0
      );
      await runtime.persistLane(lane);
      await runtime.emitEvent({
        eventId: crypto.randomUUID(),
        laneId: params.laneId,
        type: "lane.synced_from_codex",
        ts: runtime.nowIso(),
        severity: "info",
        payload: {
          threadId: effectiveThreadId,
          cwd: thread.cwd ?? null,
          source: thread.source ?? null,
          updatedAt: thread.updatedAt ?? null,
          preferredSurface,
          requirePreferredSurface,
        },
      });

      return { lane, thread };
    },
    {
      detail: {
        summary: "Sync lane metadata from Codex thread",
        tags: ["lanes"],
      },
      params: laneIdParams,
      body: laneSyncBody,
    }
  )
  .delete(
    "/lanes/:laneId",
    async ({ params, status }) => {
      const result = await runtime.deleteLane(params.laneId);
      if (!result.ok) {
        return status(404, { error: "lane_not_found" });
      }
      return {
        ok: true,
        deletedLaneId: params.laneId,
        hadSession: result.hadSession,
      };
    },
    {
      detail: {
        summary: "Delete lane and cleanup local state",
        tags: ["lanes", "maintenance"],
      },
      params: laneIdParams,
    }
  )
  .get(
    "/lanes/:laneId",
    ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      return { lane };
    },
    {
      detail: {
        summary: "Get lane",
        tags: ["lanes"],
      },
      params: laneIdParams,
    }
  )
  .get(
    "/lanes/:laneId/events",
    ({ params, status }) => {
      if (!runtime.lanes.has(params.laneId)) {
        return status(404, { error: "lane_not_found" });
      }
      return { events: runtime.laneEvents.get(params.laneId) ?? [] };
    },
    {
      detail: {
        summary: "List lane events",
        tags: ["lanes"],
      },
      params: laneIdParams,
    }
  )
  .get(
    "/lanes/:laneId/session/status",
    ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      const session = runtime.laneSessions.get(params.laneId);
      return {
        running: !!session,
        threadId: lane.threadId ?? null,
        startedAt: session?.startedAt ?? null,
        pendingRequests: session ? session.serverRequests.size : 0,
        activeTurnId: lane.activeTurnId ?? null,
        readinessMode: lane.readinessMode ?? "lenient",
        readinessDeferred: session?.readinessDeferred ?? false,
        readinessReason: session?.readinessReason ?? null,
      };
    },
    {
      detail: {
        summary: "Get lane session status",
        tags: ["lanes"],
      },
      params: laneSessionParams,
    }
  )
  .post(
    "/lanes/:laneId/session/start",
    async ({ params, body, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }

      const startBody = (body ?? {}) as {
        threadId?: string;
        readinessMode?: "strict" | "lenient";
        preferredSurface?: "mac-app" | "vscode" | "cli" | "any";
        requirePreferredSurface?: boolean;
        waitForThreadResume?: boolean;
      };
      const requestedThreadId = String(startBody.threadId ?? "").trim();
      const preferredSurface =
        startBody.preferredSurface !== undefined
          ? parseAttachPreferredSurface({ value: startBody.preferredSurface })
          : lane.preferredSurface ?? "any";
      const requirePreferredSurface = startBody.requirePreferredSurface === true;
      const waitForThreadResume = startBody.waitForThreadResume !== false;

      let laneChanged = false;

      if (startBody.readinessMode) {
        lane.readinessMode = startBody.readinessMode;
        laneChanged = true;
      }

      if (startBody.preferredSurface !== undefined) {
        lane.preferredSurface = preferredSurface;
        laneChanged = true;
      }

      if (requestedThreadId) {
        let thread: CodexThread | null = null;
        try {
          thread = await runtime.getCodexThreadById(requestedThreadId);
        } catch (error) {
          return status(502, {
            error: "codex_rpc_failed",
            message: (error as Error).message,
          });
        }
        if (!thread) {
          return status(404, { error: "thread_not_found" });
        }

        const detectedSurface =
          thread.surface ?? runtime.normalizeSurface(thread.source);
        if (
          isSurfaceMismatch({
            requirePreferredSurface,
            preferredSurface,
            detectedSurface,
          })
        ) {
          return status(409, {
            error: "surface_mismatch",
            message: `thread surface ${detectedSurface} does not match preferredSurface ${preferredSurface}`,
          });
        }

        lane.threadId = requestedThreadId;
        lane.repoRoot = thread.cwd ?? lane.repoRoot;
        lane.surface = detectedSurface;
        runtime.attachedThreadLastUpdated.set(
          requestedThreadId,
          thread.updatedAt ?? 0
        );
        laneChanged = true;
      } else if (
        requirePreferredSurface &&
        preferredSurface !== "any" &&
        (lane.surface ?? "unknown") !== preferredSurface
      ) {
        return status(409, {
          error: "surface_mismatch",
          message: `lane surface ${lane.surface ?? "unknown"} does not match preferredSurface ${preferredSurface}`,
        });
      }

      if (laneChanged) {
        lane.updatedAt = runtime.nowIso();
        await runtime.persistLane(lane);
      }

      if (!lane.threadId) {
        return status(400, {
          error: "lane_not_attached",
          message:
            "start session requires lane threadId; provide threadId in request body",
        });
      }
      try {
        const session = await runtime.startLaneSession(lane, {
          waitForThreadResume,
          emitStartedEvent: true,
        });
        if (lane.status !== "running") {
          await runtime.setLaneStatus(lane, "running", "lane.running", {
            threadId: lane.threadId,
          });
        }
        return {
          ok: true,
          running: true,
          startedAt: session.startedAt,
          threadId: lane.threadId,
          waitForThreadResume,
          readinessMode: lane.readinessMode ?? "lenient",
        };
      } catch (error) {
        await runtime.setLaneStatus(lane, "blocked", "lane.session.blocked", {
          reason: (error as Error).message,
          threadId: lane.threadId,
        });
        return status(502, {
          error: "lane_session_start_failed",
          message: (error as Error).message,
        });
      }
    },
    {
      detail: {
        summary: "Start lane session",
        tags: ["lanes"],
      },
      params: laneSessionParams,
      body: laneSessionStartBody,
    }
  )
  .post(
    "/lanes/:laneId/session/stop",
    async ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      const stopped = await runtime.stopLaneSession(params.laneId);
      await runtime.emitEvent({
        eventId: crypto.randomUUID(),
        laneId: params.laneId,
        type: "lane.session.stopped",
        ts: runtime.nowIso(),
        severity: "info",
      });
      return { ok: true, stopped };
    },
    {
      detail: {
        summary: "Stop lane session",
        tags: ["lanes"],
      },
      params: laneSessionParams,
    }
  )
  .post(
    "/lanes/:laneId/:action",
    async ({ params, body, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }

      const payload: LaneActionPayload = {
        laneId: params.laneId,
        action: params.action,
      };

      try {
        const actionBody = body as LaneActionBodyInput;
        if (lane.threadId) {
          await runThreadedLaneAction({
            payload,
            lane,
            body: actionBody,
          });
        } else {
          await runUnattachedLaneAction({
            payload,
            lane,
            body: actionBody,
          });
        }
        return { ok: true, lane };
      } catch (error) {
        if (error instanceof LaneActionError) {
          return status(error.statusCode, error.payload);
        }
        const message = (error as Error).message;
        if (lane.threadId) {
          await emitLaneTurnFailure({
            payload,
            lane,
            errorMessage: message,
          });
        }
        return status(502, {
          error: "codex_turn_failed",
          message,
        });
      }
    },
    {
      detail: {
        summary: "Prompt, steer, or interrupt lane work",
        tags: ["lanes"],
      },
      params: laneActionParams,
      body: lanePromptBody,
    }
  )
  .get(
    "/lanes/:laneId/approvals",
    ({ params, status }) => {
      if (!runtime.lanes.has(params.laneId)) {
        return status(404, { error: "lane_not_found" });
      }
      return { approvals: runtime.approvals.get(params.laneId) ?? [] };
    },
    {
      detail: {
        summary: "List pending and resolved approvals",
        tags: ["lanes", "approvals"],
      },
      params: laneIdParams,
    }
  )
  .post(
    "/lanes/:laneId/approvals/:approvalId/:action",
    async ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }

      const list = runtime.approvals.get(params.laneId) ?? [];
      const item = list.find((entry) => entry.approvalId === params.approvalId);
      if (!item) {
        return status(404, { error: "approval_not_found" });
      }

      item.status = params.action === "approve" ? "approved" : "denied";
      item.resolvedAt = runtime.nowIso();

      if (
        item.rpcRequestId !== undefined &&
        runtime.laneSessions.has(params.laneId)
      ) {
        await runtime.laneSessionRespondApproval(
          params.laneId,
          item.rpcRequestId,
          item.status === "approved" ? "approved" : "denied"
        );
      }

      await runtime.emitEvent({
        eventId: crypto.randomUUID(),
        laneId: params.laneId,
        type: "lane.approval.resolved",
        ts: item.resolvedAt,
        severity: "info",
        payload: {
          approvalId: params.approvalId,
          status: item.status,
        },
      });

      if (lane.status === "needs_approval" && item.status === "approved") {
        await runtime.setLaneStatus(lane, "running", "lane.running");
      }

      await runtime.persistLane(lane);
      return { approval: item, lane };
    },
    {
      detail: {
        summary: "Approve or deny approval request",
        tags: ["lanes", "approvals"],
      },
      params: laneApprovalParams,
    }
  );
