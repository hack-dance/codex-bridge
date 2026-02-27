import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

const debugApprovalBody = t.Object({
  laneId: t.String(),
  source: t.Optional(t.Union([t.Literal("app-server"), t.Literal("runtime")])),
  reason: t.Optional(t.String()),
});

const debugCompleteBody = t.Object({
  laneId: t.String(),
  note: t.Optional(t.String()),
});

export const debugModule = new Elysia({ name: "debug-module" })
  .post(
    "/debug/request-approval",
    async ({ body, status }) => {
      const lane = runtime.getLaneOr404(body.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }

      const approval = {
        approvalId: `apr_${crypto.randomUUID()}`,
        laneId: body.laneId,
        source: body.source ?? "app-server",
        reason: String(body.reason ?? "manual debug approval"),
        status: "pending" as const,
        createdAt: runtime.nowIso(),
      };

      const list = runtime.approvals.get(body.laneId) ?? [];
      list.push(approval);
      runtime.approvals.set(body.laneId, list);

      await runtime.setLaneStatus(
        lane,
        "needs_approval",
        "lane.approval.requested",
        {
          approvalId: approval.approvalId,
          reason: approval.reason,
        }
      );

      return { approval, lane };
    },
    {
      detail: {
        summary: "Inject a synthetic approval request",
        tags: ["debug"],
      },
      body: debugApprovalBody,
    }
  )
  .post(
    "/debug/complete",
    async ({ body, status }) => {
      const lane = runtime.getLaneOr404(body.laneId);
      if (!lane) {
        return status(404, { error: "lane_not_found" });
      }
      lane.status = "done";
      lane.updatedAt = runtime.nowIso();
      await runtime.persistLane(lane);
      await runtime.emitLaneCompletion(
        lane,
        {},
        String(body.note ?? "debug complete")
      );
      return { lane };
    },
    {
      detail: {
        summary: "Force complete a lane for debugging",
        tags: ["debug"],
      },
      body: debugCompleteBody,
    }
  );
