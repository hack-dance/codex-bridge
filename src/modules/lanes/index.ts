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
  acceptanceCriteria: t.Optional(t.Array(t.String())),
  verificationCommands: t.Optional(t.Array(t.String())),
});

const lanePromptBody = t.Object({
  input: t.Optional(t.String()),
});

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

async function requestLaneTurnStart({
  payload,
  lane,
  input,
}: {
  payload: LaneActionPayload;
  lane: Lane;
  input: string;
}) {
  const result = await runtime.laneSessionRequest(
    payload.laneId,
    "turn/start",
    {
      threadId: lane.threadId,
      input: [{ type: "text", text: input }],
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
  const result = await runtime.laneSessionRequest(
    payload.laneId,
    "turn/steer",
    {
      threadId: lane.threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: input }],
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
  const result = await runtime.laneSessionRequest(
    payload.laneId,
    "turn/interrupt",
    {
      threadId: lane.threadId,
      turnId: activeTurnId,
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

      const preferredSurface = String(body.preferredSurface ?? "any") as
        | "mac-app"
        | "vscode"
        | "cli"
        | "any";
      const requirePreferredSurface =
        body.requirePreferredSurface === undefined
          ? false
          : Boolean(body.requirePreferredSurface);
      const detectedSurface =
        thread.surface ?? runtime.normalizeSurface(thread.source);

      if (
        requirePreferredSurface &&
        preferredSurface !== "any" &&
        detectedSurface !== preferredSurface
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
    async ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      if (!lane.threadId) {
        return status(400, { error: "lane_not_attached" });
      }

      let thread: CodexThread | null = null;
      try {
        thread = await runtime.getCodexThreadById(lane.threadId);
      } catch (error) {
        return status(502, {
          error: "codex_rpc_failed",
          message: (error as Error).message,
        });
      }
      if (!thread) {
        return status(404, { error: "thread_not_found" });
      }

      lane.repoRoot = thread.cwd ?? lane.repoRoot;
      lane.surface =
        thread.surface ?? runtime.normalizeSurface(thread.source) ?? "unknown";
      lane.updatedAt = runtime.nowIso();
      runtime.attachedThreadLastUpdated.set(
        lane.threadId,
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
          threadId: lane.threadId,
          cwd: thread.cwd ?? null,
          source: thread.source ?? null,
          updatedAt: thread.updatedAt ?? null,
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
    async ({ params, status }) => {
      const lane = runtime.getLaneOr404(params.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      if (!lane.threadId) {
        return status(400, { error: "lane_not_attached" });
      }
      try {
        const session = await runtime.startLaneSession(lane);
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
