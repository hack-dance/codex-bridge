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

const debugReconcileBody = t.Object({
  clearSyntheticRunningLanes: t.Optional(t.Boolean()),
  clearOrphanedActiveTurns: t.Optional(t.Boolean()),
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
  )
  .post(
    "/debug/reconcile-stale",
    async ({ body }) => {
      const clearSyntheticRunningLanes =
        body.clearSyntheticRunningLanes !== false;
      const clearOrphanedActiveTurns = body.clearOrphanedActiveTurns !== false;
      const updates: Array<{
        laneId: string;
        changes: string[];
      }> = [];

      for (const lane of runtime.lanes.values()) {
        const changes: string[] = [];
        if (
          clearSyntheticRunningLanes &&
          lane.threadId &&
          runtime.isSyntheticThreadId(lane.threadId) &&
          lane.status === "running"
        ) {
          await runtime.setLaneStatus(
            lane,
            "blocked",
            "lane.reconciled.synthetic_thread",
            {
              threadId: lane.threadId,
            }
          );
          changes.push("blocked_synthetic_running_lane");
        }

        if (
          clearOrphanedActiveTurns &&
          lane.activeTurnId &&
          !runtime.laneSessions.has(lane.laneId)
        ) {
          const staleTurnId = lane.activeTurnId;
          lane.activeTurnId = undefined;
          lane.updatedAt = runtime.nowIso();
          await runtime.persistLane(lane);
          await runtime.emitEvent({
            eventId: crypto.randomUUID(),
            laneId: lane.laneId,
            type: "lane.turn.reconciled.orphaned",
            ts: runtime.nowIso(),
            severity: "warn",
            payload: {
              threadId: lane.threadId ?? null,
              staleTurnId,
            },
          });
          changes.push("cleared_orphaned_active_turn");
        }

        if (changes.length > 0) {
          updates.push({ laneId: lane.laneId, changes });
        }
      }

      return {
        ok: true,
        updates,
        count: updates.length,
      };
    },
    {
      detail: {
        summary: "Reconcile stale synthetic lanes and orphaned active turns",
        tags: ["debug", "lanes"],
      },
      body: debugReconcileBody,
    }
  );
