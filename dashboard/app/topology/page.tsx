"use client";

import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type ReactFlowInstance,
  ReactFlow,
} from "@xyflow/react";
import { Activity, Layers, RefreshCw, Search, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ActionButton,
  Banner,
  EmptyState,
  Panel,
} from "@/components/hud-primitives";
import type { DashboardLane, DashboardThread } from "@/lib/dashboard-data";
import { laneStatusClassName, runtimeOriginLabel } from "@/lib/dashboard-ui";
import {
  buildProjectSummaries,
  type DashboardProjectSummary,
} from "@/lib/project-summary";
import {
  runDashboardAction,
  useDashboardSnapshot,
} from "@/lib/use-dashboard-snapshot";

const PROJECT_COLUMN_WIDTH = 1120;
const PROJECT_PADDING_X = 22;
const PROJECT_PADDING_Y = 22;
const PROJECT_TOP_MARGIN = 76;
const PROJECT_NODE_BASE_HEIGHT = 300;
const THREAD_TO_THREAD_GROUP_GAP = 22;
const THREAD_NODE_WIDTH = 250;
const LANE_NODE_WIDTH = 270;
const SESSION_NODE_WIDTH = 250;
const THREAD_NODE_MIN_HEIGHT = 132;
const LANE_Y_STEP = 98;
const LANE_BASE_Y_OFFSET = 84;
const SESSION_X_OFFSET = 280;
const LANE_X_OFFSET = 260;

const DEFAULT_THREAD_CAP = 140;
const DEFAULT_SUBAGENT_CAP = 6;
const DEFAULT_CLEANUP_HOURS = 8;
const DEFAULT_STALE_THREAD_HOURS = 6;
const DEFAULT_TOPOLOGY_MODE = "ops";
const TERMINAL_LANE_STATUSES = new Set([
  "blocked",
  "done",
  "failed",
  "interrupted",
]);
const PROBLEM_LANE_STATUSES = new Set(["needs_approval", "blocked", "failed", "interrupted"]);

type TopologyMode = "ops" | "debug" | "audit";

interface TopologyRow {
  thread: DashboardThread;
  depth: number;
}

interface TopologyMeta {
  kind: "thread" | "lane" | "session";
  id: string;
  title: string;
  subtitle: string;
  details: Array<{ label: string; value: string }>;
  href: string;
  status?: string;
}

type ProjectSummary = DashboardProjectSummary;

const miniMapNodeColor = ({
  node,
}: {
  node: Node<{ label: ReactNode; meta?: TopologyMeta }>;
}): string => {
  if (node.id.startsWith("project:")) {
    return "#3f3f46";
  }
  if (node.id.startsWith("missing-parent:")) {
    return "#6366f1";
  }
  const meta = node.data.meta;
  if (!meta) {
    return "#71717a";
  }
  if (meta.kind === "thread") {
    return "#22d3ee";
  }
  if (meta.kind === "session") {
    return "#67e8f9";
  }
  if (meta.status === "failed") {
    return "#ef4444";
  }
  if (meta.status === "blocked" || meta.status === "needs_approval") {
    return "#f59e0b";
  }
  if (meta.status === "running" || meta.status === "starting") {
    return "#22c55e";
  }
  return "#94a3b8";
};

interface ScopeAwareWebhook {
  enabled: boolean;
  scope?: {
    laneIds: string[];
    threadIds: string[];
    sessionIds: string[];
  };
}

interface CollapsedTopologyResult {
  rows: TopologyRow[];
  hiddenByParent: Map<string, number>;
  hiddenByThreadCap: number;
}

const baseNodeStyle = {
  border: "1px solid #3f3f46",
  borderRadius: "12px",
  background: "#101012",
  color: "#f4f4f5",
  width: THREAD_NODE_WIDTH,
  fontSize: 12,
  padding: "10px 12px",
  boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
} as const;

const groupNodeStyle = {
  ...baseNodeStyle,
  background: "#0a0a0d",
  border: "1px solid #2a2a33",
  borderRadius: "18px",
  padding: "12px 14px",
  width: PROJECT_COLUMN_WIDTH - 48,
  fontSize: 11,
  boxShadow: "none",
} as const;

const missingParentNodeStyle = {
  ...baseNodeStyle,
  background: "#0e1020",
  border: "1px dashed #6366f1",
  color: "#c7d2fe",
  boxShadow:
    "0 0 0 1px rgba(99, 102, 241, 0.22), 0 8px 22px rgba(99, 102, 241, 0.16)",
} as const;

const paletteForLane = ({
  status,
  running,
}: {
  status: string;
  running: boolean;
}) => {
  if (running) {
    return {
      background: "#0f2a24",
      border: "#34d399",
      glow: "0 0 0 1px rgba(52, 211, 153, 0.22)",
      text: "#ecfdf5",
    };
  }
  if (status === "running" || status === "done") {
    return {
      background: "#122318",
      border: "#22c55e",
      glow: "0 0 0 1px rgba(34, 197, 94, 0.22)",
      text: "#dcfce7",
    };
  }
  if (status === "starting" || status === "verifying") {
    return {
      background: "#0b1728",
      border: "#38bdf8",
      glow: "0 0 0 1px rgba(56, 189, 248, 0.2)",
      text: "#e0f2fe",
    };
  }
  if (status === "failed") {
    return {
      background: "#2f0f12",
      border: "#ef4444",
      glow: "0 0 0 1px rgba(239, 68, 68, 0.3)",
      text: "#fee2e2",
    };
  }
  if (status === "interrupted") {
    return {
      background: "#2a1711",
      border: "#f97316",
      glow: "0 0 0 1px rgba(249, 115, 22, 0.28)",
      text: "#ffedd5",
    };
  }
  if (status === "needs_approval" || status === "blocked") {
    return {
      background: "#2a2115",
      border: "#f59e0b",
      glow: "0 0 0 1px rgba(245, 158, 11, 0.24)",
      text: "#fef3c7",
    };
  }
  return {
    background: "#1f1f24",
    border: "#71717a",
    glow: "0 0 0 1px rgba(113, 113, 122, 0.2)",
    text: "#f4f4f5",
  };
};

const threadNodeStyle = ({
  active,
  hasChildren,
  isSubAgent,
}: {
  active: boolean;
  hasChildren: boolean;
  isSubAgent: boolean;
}) => {
  if (active) {
    return {
      ...baseNodeStyle,
      border: isSubAgent ? "1px solid #a78bfa" : "1px solid #22d3ee",
      boxShadow:
        isSubAgent
          ? "0 10px 28px rgba(167, 139, 250, 0.15), 0 0 0 1px rgba(167, 139, 250, 0.22)"
          : "0 10px 28px rgba(34, 211, 238, 0.15), 0 0 0 1px rgba(34, 211, 238, 0.22)",
      width: THREAD_NODE_WIDTH,
      background: isSubAgent ? "#1b1230" : hasChildren ? "#10212a" : "#101824",
      color: isSubAgent ? "#f5f3ff" : "#ecfeff",
    };
  }
  if (isSubAgent) {
    return {
      ...baseNodeStyle,
      background: "#171129",
      border: "1px solid #7c3aed",
      width: THREAD_NODE_WIDTH,
      color: "#ede9fe",
      boxShadow: "0 5px 20px rgba(124, 58, 237, 0.2)",
    };
  }
  return {
    ...baseNodeStyle,
    background: hasChildren ? "#111318" : "#0e1014",
    border: hasChildren ? "1px solid #5b5b6a" : "1px solid #3d3d45",
    width: THREAD_NODE_WIDTH,
    boxShadow: hasChildren
      ? "0 6px 24px rgba(0,0,0,0.3)"
      : "0 4px 16px rgba(0,0,0,0.22)",
  };
};

const isSubAgentThread = ({ thread }: { thread: DashboardThread }): boolean =>
  thread.sourceKind.startsWith("subAgent") ||
  thread.sourceGroup.includes("sub-agent");

const buildTopologyRows = ({
  threads,
}: {
  threads: DashboardThread[];
}): TopologyRow[] => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<string, DashboardThread[]>();
  const roots: DashboardThread[] = [];

  for (const thread of threads) {
    const parentId = thread.sourceParentThreadId;
    if (parentId && byId.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(thread);
      childrenByParent.set(parentId, list);
      continue;
    }
    roots.push(thread);
  }

  const sortByRecent = (left: DashboardThread, right: DashboardThread) =>
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  roots.sort(sortByRecent);
  for (const children of childrenByParent.values()) {
    children.sort(sortByRecent);
  }

  const out: TopologyRow[] = [];
  const seen = new Set<string>();
  const walk = ({
    thread,
    depth,
  }: {
    thread: DashboardThread;
    depth: number;
  }) => {
    if (seen.has(thread.id)) {
      return;
    }
    seen.add(thread.id);
    out.push({ thread, depth });
    for (const child of childrenByParent.get(thread.id) ?? []) {
      walk({ thread: child, depth: depth + 1 });
    }
  };
  for (const root of roots) {
    walk({ thread: root, depth: 0 });
  }
  return out;
};

const webhookMatches = ({
  subscription,
  threadId,
  laneId,
  sessionId,
}: {
  subscription: ScopeAwareWebhook;
  threadId: string;
  laneId?: string;
  sessionId?: string;
}) => {
  if (!subscription.enabled) {
    return false;
  }
  const laneTargets = subscription.scope?.laneIds ?? [];
  const threadTargets = subscription.scope?.threadIds ?? [];
  const sessionTargets = subscription.scope?.sessionIds ?? [];
  if (
    laneTargets.length === 0 &&
    threadTargets.length === 0 &&
    sessionTargets.length === 0
  ) {
    return true;
  }
  if (threadTargets.length > 0 && !threadTargets.includes(threadId)) {
    return false;
  }
  if (laneTargets.length > 0 && !(laneId && laneTargets.includes(laneId))) {
    return false;
  }
  if (
    sessionTargets.length > 0 &&
    !(sessionId && sessionTargets.includes(sessionId))
  ) {
    return false;
  }
  return true;
};

const toMetaLabel = ({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): ReactNode => (
  <div className="space-y-1">
    <p className="font-medium text-[12px] text-zinc-100">{title}</p>
    <p className="mono text-[11px] text-zinc-400">{subtitle}</p>
  </div>
);

const buildProjectOrder = ({ rows }: { rows: TopologyRow[] }): string[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.thread.projectName ?? "Unassigned";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )
    .map(([key]) => key);
};

const buildCollapsedRows = ({
  rows,
  maxSubAgentsPerParent,
  maxThreads,
}: {
  rows: TopologyRow[];
  maxSubAgentsPerParent: number;
  maxThreads: number;
}): CollapsedTopologyResult => {
  const hiddenByParent = new Map<string, number>();
  const subAgentCountsByParent = new Map<string, number>();
  const visibleRows: TopologyRow[] = [];
  const skippedDepthStack: number[] = [];

  for (const row of rows) {
    while (
      skippedDepthStack.length > 0 &&
      row.depth <= (skippedDepthStack.at(-1) ?? 0)
    ) {
      skippedDepthStack.pop();
    }
    if (skippedDepthStack.length > 0) {
      continue;
    }

    const parentId = row.thread.sourceParentThreadId;
    const isSubAgentChild =
      parentId !== null &&
      (row.thread.sourceKind.startsWith("subAgent") ||
        row.thread.sourceGroup.includes("sub-agent"));

    if (isSubAgentChild && parentId) {
      const nextCount = (subAgentCountsByParent.get(parentId) ?? 0) + 1;
      subAgentCountsByParent.set(parentId, nextCount);
      if (nextCount > maxSubAgentsPerParent) {
        hiddenByParent.set(parentId, (hiddenByParent.get(parentId) ?? 0) + 1);
        skippedDepthStack.push(row.depth);
        continue;
      }
    }

    visibleRows.push(row);
    if (visibleRows.length >= maxThreads) {
      return {
        rows: visibleRows,
        hiddenByParent,
        hiddenByThreadCap: Math.max(0, rows.length - visibleRows.length),
      };
    }
  }

  return {
    rows: visibleRows,
    hiddenByParent,
    hiddenByThreadCap: 0,
  };
};

export default function TopologyPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } =
    useDashboardSnapshot();
  const [search, setSearch] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("search") ?? "";
  });
  const [selectedNode, setSelectedNode] = useState<TopologyMeta | null>(null);
  const [topologyMode, setTopologyMode] =
    useState<TopologyMode>(DEFAULT_TOPOLOGY_MODE);
  const [viewMode, setViewMode] = useState<"focused" | "all">("focused");
  const [layoutPreset, setLayoutPreset] = useState<"compact" | "roomy">(
    "roomy"
  );
  const [maxThreads, setMaxThreads] = useState(DEFAULT_THREAD_CAP);
  const [maxSubAgentsPerParent, setMaxSubAgentsPerParent] =
    useState(DEFAULT_SUBAGENT_CAP);
  const [hideStaleThreads, setHideStaleThreads] = useState(true);
  const [staleThreadHours, setStaleThreadHours] = useState(
    DEFAULT_STALE_THREAD_HOURS
  );
  const [cleanupHours, setCleanupHours] = useState(DEFAULT_CLEANUP_HOURS);
  const [cleanupArmed, setCleanupArmed] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [archiveThreadsArmed, setArchiveThreadsArmed] = useState(false);
  const [deleteLanesArmed, setDeleteLanesArmed] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [projectFilterQuery, setProjectFilterQuery] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [reactFlowInstance, setReactFlowInstance] = useState<
    ReactFlowInstance<Node<{ label: ReactNode; meta?: TopologyMeta }>, Edge> | null
  >(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);

  const runAction = async ({
    payload,
    actionKey,
    successMessage,
  }: {
    payload: Record<string, unknown>;
    actionKey: string;
    successMessage: string;
  }) => {
    setPendingActionKey(actionKey);
    setActionError(null);
    setActionMessage(null);
    try {
      await runDashboardAction({ payload });
      setActionMessage(successMessage);
      await refreshSnapshot({ isPoll: false });
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Action failed";
      setActionError(message);
    } finally {
      setPendingActionKey(null);
    }
  };

  const applyTopologyModePreset = useCallback(({ mode }: { mode: TopologyMode }) => {
    setTopologyMode(mode);
    setArchiveThreadsArmed(false);
    setDeleteLanesArmed(false);
    if (mode === "ops") {
      setViewMode("focused");
      setHideStaleThreads(true);
      setStaleThreadHours(DEFAULT_STALE_THREAD_HOURS);
      setLayoutPreset("roomy");
      return;
    }
    if (mode === "debug") {
      setViewMode("all");
      setHideStaleThreads(false);
      setLayoutPreset("roomy");
      return;
    }
    setViewMode("all");
    setHideStaleThreads(false);
    setLayoutPreset("compact");
  }, []);

  const laneByThread = useMemo(() => {
    const map = new Map<string, DashboardLane[]>();
    for (const lane of snapshot?.lanes ?? []) {
      if (!lane.threadId) {
        continue;
      }
      const list = map.get(lane.threadId) ?? [];
      list.push(lane);
      map.set(lane.threadId, list);
    }
    return map;
  }, [snapshot?.lanes]);

  const runningSessionByLaneId = useMemo(
    () =>
      new Map(
        (snapshot?.laneSessions ?? [])
          .filter((session) => session.running)
          .map((session) => [session.laneId, session])
      ),
    [snapshot?.laneSessions]
  );

  const liveThreadIds = useMemo(() => {
    const threadIds = new Set<string>(
      (snapshot?.activeThreads ?? []).map((thread) => thread.id)
    );
    const laneById = new Map((snapshot?.lanes ?? []).map((lane) => [lane.laneId, lane]));
    for (const session of snapshot?.laneSessions ?? []) {
      if (
        session.running ||
        session.pendingRequests > 0 ||
        session.readinessDeferred
      ) {
        if (session.threadId) {
          threadIds.add(session.threadId);
          continue;
        }
        const lane = laneById.get(session.laneId);
        if (lane?.threadId) {
          threadIds.add(lane.threadId);
        }
      }
    }
    const nowMs = Date.now();
    for (const laneEvent of snapshot?.laneEvents ?? []) {
      if (
        !laneEvent.type.startsWith("lane.turn.") &&
        laneEvent.type !== "lane.session.started"
      ) {
        continue;
      }
      const eventMs = Date.parse(laneEvent.ts);
      if (Number.isNaN(eventMs) || nowMs - eventMs > 20_000) {
        continue;
      }
      const lane = laneById.get(laneEvent.laneId);
      if (lane?.threadId) {
        threadIds.add(lane.threadId);
      }
    }
    return threadIds;
  }, [
    snapshot?.activeThreads,
    snapshot?.laneEvents,
    snapshot?.laneSessions,
    snapshot?.lanes,
  ]);

  const topologyRows = useMemo(() => {
    const allThreads = snapshot?.threads ?? [];
    const activeThreadIds = new Set(
      (snapshot?.activeThreads ?? []).map((thread) => thread.id)
    );
    const runningSessionLaneIds = new Set(
      (snapshot?.laneSessions ?? [])
        .filter((session) => session.running)
        .map((session) => session.laneId)
    );
    const baseRows =
      viewMode === "all"
        ? buildTopologyRows({ threads: allThreads })
        : (() => {
            const byId = new Map(
              allThreads.map((thread) => [thread.id, thread])
            );
            const activeThreadIds = new Set(
              (snapshot?.activeThreads ?? []).map((thread) => thread.id)
            );
            const laneThreadIds = new Set(
              (snapshot?.lanes ?? [])
                .map((lane) => lane.threadId)
                .filter((threadId): threadId is string => Boolean(threadId))
            );
            const sessionThreadIds = new Set(
              (snapshot?.laneSessions ?? [])
                .map((session) => session.threadId)
                .filter((threadId): threadId is string => Boolean(threadId))
            );
            const seedIds = new Set<string>([
              ...activeThreadIds,
              ...laneThreadIds,
              ...sessionThreadIds,
            ]);
            if (seedIds.size === 0) {
              return buildTopologyRows({ threads: allThreads.slice(0, 40) });
            }
            const included = new Set<string>();
            for (const seedId of seedIds) {
              let current = byId.get(seedId);
              while (current) {
                if (included.has(current.id)) {
                  break;
                }
                included.add(current.id);
                current = current.sourceParentThreadId
                  ? byId.get(current.sourceParentThreadId)
                  : undefined;
              }
            }
            for (const thread of allThreads) {
              if (
                !(
                  thread.sourceParentThreadId &&
                  included.has(thread.sourceParentThreadId)
                )
              ) {
                continue;
              }
              if (
                activeThreadIds.has(thread.id) ||
                laneThreadIds.has(thread.id) ||
                sessionThreadIds.has(thread.id) ||
                isSubAgentThread({ thread })
              ) {
                included.add(thread.id);
              }
            }

            let addedInPass = true;
            while (addedInPass) {
              addedInPass = false;
              for (const thread of allThreads) {
                const parentId = thread.sourceParentThreadId;
                if (!parentId || !included.has(parentId) || included.has(thread.id)) {
                  continue;
                }
                if (isSubAgentThread({ thread })) {
                  included.add(thread.id);
                  addedInPass = true;
                }
              }
            }
            return buildTopologyRows({
              threads: allThreads.filter((thread) => included.has(thread.id)),
            });
          })();

    const staleThresholdSec =
      Math.floor(Date.now() / 1000) - Math.max(1, staleThreadHours) * 60 * 60;
    const rowsWithFreshnessFilter =
      hideStaleThreads && search.trim().length === 0
        ? baseRows.filter(({ thread }) => {
            if (activeThreadIds.has(thread.id)) {
              return true;
            }
            const threadLanes = laneByThread.get(thread.id) ?? [];
            if (threadLanes.length === 0) {
              return true;
            }
            const hasRunningSession = threadLanes.some((lane) =>
              runningSessionLaneIds.has(lane.laneId)
            );
            if (hasRunningSession) {
              return true;
            }
            const hasNonTerminalLane = threadLanes.some(
              (lane) => !TERMINAL_LANE_STATUSES.has(lane.status)
            );
            if (hasNonTerminalLane) {
              return true;
            }
            const updatedAt = thread.updatedAt ?? 0;
            return updatedAt >= staleThresholdSec;
          })
        : baseRows;

    const allThreadIds = new Set(allThreads.map((thread) => thread.id));
    const rowsWithModeFilter =
      topologyMode === "debug"
        ? rowsWithFreshnessFilter
        : rowsWithFreshnessFilter.filter(({ thread }) => {
            const threadLanes = laneByThread.get(thread.id) ?? [];
            const hasMissingParent = Boolean(
              thread.sourceParentThreadId &&
                !allThreadIds.has(thread.sourceParentThreadId)
            );
            const hasProblemLane = threadLanes.some((lane) =>
              PROBLEM_LANE_STATUSES.has(lane.status)
            );
            const hasRunningSession = threadLanes.some((lane) =>
              runningSessionLaneIds.has(lane.laneId)
            );
            const hasNonTerminalLane = threadLanes.some(
              (lane) => !TERMINAL_LANE_STATUSES.has(lane.status)
            );
            const subAgent = isSubAgentThread({ thread });
            if (topologyMode === "audit") {
              return hasMissingParent || hasProblemLane || subAgent;
            }
            return (
              activeThreadIds.has(thread.id) ||
              hasRunningSession ||
              hasNonTerminalLane ||
              hasProblemLane ||
              hasMissingParent
            );
          });

    const rowsWithLiveFilter = liveOnly
      ? rowsWithModeFilter.filter(({ thread }) => liveThreadIds.has(thread.id))
      : rowsWithModeFilter;

    const lowered = search.trim().toLowerCase();
    if (!lowered) {
      return rowsWithLiveFilter;
    }
    return rowsWithLiveFilter.filter(({ thread }) => {
      const attachedLanes = laneByThread.get(thread.id) ?? [];
      const haystack = [
        thread.id,
        thread.displayName,
        thread.projectName,
        thread.title,
        thread.originator,
        thread.sourceLabel,
        thread.sourceDetail,
        thread.sourceParentThreadId,
        ...attachedLanes.map((lane) => lane.displayName),
        ...attachedLanes.map((lane) => lane.laneId),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(lowered);
    });
  }, [
    snapshot?.threads,
    snapshot?.activeThreads,
    snapshot?.lanes,
    snapshot?.laneSessions,
    viewMode,
    search,
    laneByThread,
    hideStaleThreads,
    staleThreadHours,
    topologyMode,
    liveOnly,
    liveThreadIds,
  ]);

  const collapsedTopology = useMemo(
    () =>
      buildCollapsedRows({
        rows: topologyRows,
        maxSubAgentsPerParent: Math.max(1, maxSubAgentsPerParent),
        maxThreads: Math.max(10, maxThreads),
      }),
    [topologyRows, maxSubAgentsPerParent, maxThreads]
  );

  const flowGraph = useMemo(() => {
    const rows = collapsedTopology.rows;
    const projectOrder = buildProjectOrder({ rows });
    const projectIndexByName = new Map(
      projectOrder.map((name, index) => [name, index])
    );
    const rowsByProject = new Map<string, TopologyRow[]>();
    const nodeIds = new Set(rows.map((row) => row.thread.id));
    const nowSec = Math.floor(Date.now() / 1000);
    const nodes: Node<{ label: ReactNode; meta?: TopologyMeta }>[] = [];
    const edges: Edge[] = [];
    const projectSummaries: ProjectSummary[] = [];
    let missingParentEdgeCount = 0;

    const spacing = layoutPreset === "compact" ? 0.88 : 1.12;
    const layoutProjectColumnWidth = Math.round(PROJECT_COLUMN_WIDTH * spacing);
    const layoutThreadToThreadGap = Math.round(
      THREAD_TO_THREAD_GROUP_GAP * spacing
    );
    const layoutThreadMinHeight = Math.round(THREAD_NODE_MIN_HEIGHT * spacing);
    const layoutLaneYStep = Math.round(LANE_Y_STEP * spacing);
    const layoutLaneBaseYOffset = Math.round(LANE_BASE_Y_OFFSET * spacing);
    const layoutSessionXOffset = Math.round(SESSION_X_OFFSET * spacing);
    const layoutLaneXOffset = Math.round(LANE_X_OFFSET * spacing);
    const layoutThreadDepthXStep = Math.round(34 * spacing);

    for (const row of rows) {
      const projectName = row.thread.projectName ?? "Unassigned";
      const list = rowsByProject.get(projectName) ?? [];
      list.push(row);
      rowsByProject.set(projectName, list);
    }

    for (const projectName of projectOrder) {
      const projectIndex = projectIndexByName.get(projectName) ?? 0;
      const projectId = `project:${projectName}`;
      const projectX = projectIndex * layoutProjectColumnWidth + 20;
      const projectRows = rowsByProject.get(projectName) ?? [];
      const missingParentText =
        viewMode === "focused"
          ? "outside focused snapshot"
          : "outside current topology view";
      if (projectRows.length === 0) {
        continue;
      }

      const projectThreadIds = new Set(projectRows.map((row) => row.thread.id));
      const projectLanes = (snapshot?.lanes ?? []).filter((lane) =>
        lane.threadId ? projectThreadIds.has(lane.threadId) : false
      );
      const projectRunningSessionCount = projectLanes.filter((lane) =>
        runningSessionByLaneId.has(lane.laneId)
      ).length;
      const projectAgentCount = projectRows.filter(({ thread }) =>
        isSubAgentThread({ thread })
      ).length;
      const projectProblemLaneCount = projectLanes.filter((lane) =>
        PROBLEM_LANE_STATUSES.has(lane.status)
      ).length;

      const missingParentIds = [
        ...new Set(
          projectRows
            .map((rowItem) => rowItem.thread.sourceParentThreadId)
            .filter((parentId): parentId is string =>
              Boolean(parentId && !nodeIds.has(parentId))
            )
        ),
      ];

      const projectNodes: Node<{ label: ReactNode; meta?: TopologyMeta }>[] =
        [];
      const projectEdges: Edge[] = [];
      const missingParentNodeById = new Map<string, string>();
      let cursorY =
        PROJECT_TOP_MARGIN +
        (missingParentIds.length > 0 ? missingParentIds.length * 84 + 14 : 0);
      let maxChildX = PROJECT_PADDING_X + THREAD_NODE_WIDTH;

      for (const [index, missingParentId] of missingParentIds.entries()) {
        const placeholderNodeId = `missing-parent:${missingParentId}`;
        missingParentNodeById.set(missingParentId, placeholderNodeId);
        projectNodes.push({
          id: placeholderNodeId,
          position: {
            x: PROJECT_PADDING_X,
            y: PROJECT_TOP_MARGIN + index * 84,
          },
          selectable: false,
          draggable: false,
          data: {
            label: toMetaLabel({
              title: "Parent thread unavailable",
              subtitle: `${missingParentId} (${missingParentText})`,
            }),
          },
          style: {
            ...missingParentNodeStyle,
            width: THREAD_NODE_WIDTH - 22,
          },
          parentId: projectId,
          extent: "parent",
        });
      }

      for (const row of projectRows) {
        const threadLanes = laneByThread.get(row.thread.id) ?? [];
        const threadOrigin = runtimeOriginLabel({
          originator: row.thread.originator,
          sourceLabel: row.thread.sourceLabel,
          surface: row.thread.surface,
        });
        const threadMeta: TopologyMeta = {
          kind: "thread",
          id: row.thread.id,
          title: row.thread.displayName,
          subtitle: threadOrigin,
          href: `/threads?search=${encodeURIComponent(row.thread.id)}`,
          details: [
            { label: "Thread ID", value: row.thread.id },
            { label: "Project", value: row.thread.projectName ?? "Unassigned" },
            { label: "Title", value: row.thread.title ?? "Untitled" },
            { label: "Originator", value: threadOrigin },
            { label: "Source", value: row.thread.sourceLabel },
            { label: "Source detail", value: row.thread.sourceDetail ?? "none" },
            { label: "Depth", value: String(row.depth + 1) },
            { label: "Attached lanes", value: String(threadLanes.length) },
          ],
        };

        const threadDepthIndent = Math.min(4, Math.max(0, row.depth)) * layoutThreadDepthXStep;
        const threadX = PROJECT_PADDING_X + threadDepthIndent;
        const threadY = cursorY;
        const threadNodeId = `thread:${row.thread.id}`;
        const threadIsLive = liveThreadIds.has(row.thread.id);
        const threadIsSubAgent = isSubAgentThread({ thread: row.thread });
        const threadHooks = (snapshot?.webhooks ?? []).filter((subscription) =>
          webhookMatches({ subscription, threadId: row.thread.id })
        );
        const hasMissingParent = Boolean(
          row.thread.sourceParentThreadId &&
            !nodeIds.has(row.thread.sourceParentThreadId)
        );
        const parentLabel = hasMissingParent
          ? `${row.thread.sourceParentThreadId} (not loaded in this view)`
          : (row.thread.sourceParentThreadId ?? "none");
        const threadDetails: TopologyMeta = {
          ...threadMeta,
          details: [
            ...threadMeta.details,
            { label: "Parent", value: parentLabel },
            { label: "Matching webhooks", value: String(threadHooks.length) },
            {
              label: "Last updated",
              value:
                typeof row.thread.updatedAt === "number"
                  ? `${Math.max(0, nowSec - row.thread.updatedAt)}s ago`
                  : "unknown",
            },
          ],
        };

        projectNodes.push({
          id: threadNodeId,
          position: { x: threadX, y: threadY },
          data: {
            meta: threadDetails,
            label: toMetaLabel({
              title: row.thread.displayName,
              subtitle: `${row.thread.shortId} · ${threadOrigin} · hooks ${threadHooks.length}`,
            }),
          },
          style: threadNodeStyle({
            active: threadIsLive,
            hasChildren:
              threadLanes.length > 0 || row.thread.sourceKind.length > 0,
            isSubAgent: threadIsSubAgent,
          }),
          parentId: projectId,
          extent: "parent",
        });

        const parentId = row.thread.sourceParentThreadId;
        if (parentId && nodeIds.has(parentId)) {
          projectEdges.push({
            id: `thread-edge:${parentId}->${row.thread.id}`,
            source: `thread:${parentId}`,
            target: threadNodeId,
            animated: threadIsLive,
            style: {
              stroke: threadIsLive ? "#67e8f9" : "#6366f1",
              strokeWidth: threadIsLive ? 1.6 : 1.2,
            },
          });
        }
        if (parentId && !nodeIds.has(parentId)) {
          const missingParentNodeId = missingParentNodeById.get(parentId);
          if (missingParentNodeId) {
            projectEdges.push({
              id: `thread-edge:missing:${parentId}->${row.thread.id}`,
              source: missingParentNodeId,
              target: threadNodeId,
              animated: threadIsLive,
              style: {
                stroke: "#818cf8",
                strokeWidth: 1.2,
                strokeDasharray: "4 4",
              },
            });
            missingParentEdgeCount += 1;
          }
        }

        let rowBottomY = threadY + layoutThreadMinHeight;
        for (const [laneIndex, lane] of threadLanes.entries()) {
          const sessionX = threadX + layoutSessionXOffset;
          const laneX = sessionX + layoutLaneXOffset;
          const laneY =
            threadY + layoutLaneBaseYOffset + laneIndex * layoutLaneYStep;
          const session = runningSessionByLaneId.get(lane.laneId);
          const sessionY = laneY + 4;
          const lanePalette = paletteForLane({
            status: lane.status,
            running: Boolean(session),
          });
          const laneHooks = (snapshot?.webhooks ?? []).filter((subscription) =>
            webhookMatches({
              subscription,
              threadId: row.thread.id,
              laneId: lane.laneId,
              sessionId: session?.laneId,
            })
          );
          const laneMeta: TopologyMeta = {
            kind: "lane",
            id: lane.laneId,
            title: lane.displayName,
            subtitle: `status ${lane.status}`,
            status: lane.status,
            href: `/lanes?search=${encodeURIComponent(lane.laneId)}`,
            details: [
              { label: "Lane ID", value: lane.laneId },
              { label: "Project", value: lane.projectName ?? "Unassigned" },
              { label: "Thread", value: row.thread.displayName },
              { label: "Ownership model", value: "lane belongs to thread" },
              { label: "Ownership type", value: lane.ownershipLabel },
              { label: "Owner ref", value: lane.ownerRef ?? "none" },
              {
                label: "Origin",
                value: runtimeOriginLabel({
                  originator: row.thread.originator,
                  sourceLabel: row.thread.sourceLabel,
                  surface: lane.surface,
                }),
              },
              { label: "Status", value: lane.status },
              { label: "Surface", value: lane.surface ?? "unknown" },
              { label: "Session", value: session ? "running" : "stopped" },
              { label: "Matching webhooks", value: String(laneHooks.length) },
            ],
          };

          projectNodes.push({
            id: `lane:${lane.laneId}`,
            position: { x: laneX, y: laneY },
            data: {
              meta: laneMeta,
              label: toMetaLabel({
                title: lane.displayName,
                subtitle: `${lane.shortId} · ${lane.status} · hooks ${laneHooks.length}`,
              }),
            },
            style: {
              ...baseNodeStyle,
              width: LANE_NODE_WIDTH,
              background: lanePalette.background,
              border: `1px solid ${lanePalette.border}`,
              color: lanePalette.text,
              boxShadow: lanePalette.glow,
            },
            parentId: projectId,
            extent: "parent",
          });

          if (session) {
            const sessionHasWork =
              session.pendingRequests > 0 ||
              session.readinessDeferred ||
              session.running;
            const sessionNodeId = `session:${session.laneId}`;
            const sessionMeta: TopologyMeta = {
              kind: "session",
              id: session.laneId,
              title: `Session · ${lane.displayName}`,
              subtitle: `pending ${session.pendingRequests}`,
              href: `/lanes?search=${encodeURIComponent(session.laneId)}`,
              details: [
                { label: "Session key", value: session.laneId },
                { label: "Lane", value: lane.displayName },
                { label: "Thread", value: session.threadId ?? "none" },
                { label: "Ownership", value: "session belongs to lane runtime" },
                { label: "Started", value: session.startedAt ?? "unknown" },
                {
                  label: "Pending requests",
                  value: String(session.pendingRequests),
                },
                { label: "Readiness mode", value: session.readinessMode },
                {
                  label: "Deferred",
                  value: session.readinessDeferred
                    ? (session.readinessReason ?? "yes")
                    : "no",
                },
              ],
            };

            projectNodes.push({
              id: sessionNodeId,
              position: { x: sessionX, y: sessionY },
              data: {
                meta: sessionMeta,
                label: toMetaLabel({
                  title: `Session · ${lane.shortId}`,
                  subtitle: `pending ${session.pendingRequests}`,
                }),
              },
              style: {
                ...baseNodeStyle,
                width: SESSION_NODE_WIDTH,
                background: sessionHasWork ? "#102a34" : "#0f1015",
                border: `1px solid ${sessionHasWork ? "#67e8f9" : "#52525b"}`,
                color: sessionHasWork ? "#e0f2fe" : "#e4e4e7",
              },
              parentId: projectId,
              extent: "parent",
            });
            projectEdges.push({
              id: `thread-session:${row.thread.id}->${lane.laneId}`,
              source: threadNodeId,
              target: sessionNodeId,
              animated: sessionHasWork,
              style: {
                stroke: sessionHasWork ? "#67e8f9" : "#a1a1aa",
                strokeWidth: sessionHasWork ? 1.6 : 1.2,
              },
            });
            projectEdges.push({
              id: `session-lane:${lane.laneId}`,
              source: sessionNodeId,
              target: `lane:${lane.laneId}`,
              animated:
                lane.status === "running" ||
                lane.status === "starting" ||
                lane.status === "verifying",
              style: {
                stroke: lanePalette.border,
                strokeWidth: 1.3,
                strokeDasharray:
                  lane.status === "blocked" || lane.status === "failed"
                    ? "4 4"
                    : undefined,
              },
            });
          } else {
            projectEdges.push({
              id: `thread-lane:${row.thread.id}->${lane.laneId}`,
              source: threadNodeId,
              target: `lane:${lane.laneId}`,
              style: {
                stroke: lanePalette.border,
                strokeWidth: 1.15,
                strokeDasharray: "4 4",
                opacity: 0.8,
              },
            });
          }

          rowBottomY = Math.max(
            rowBottomY,
            laneY + layoutLaneYStep + 32,
            session
              ? sessionY + 90
              : threadY + layoutLaneBaseYOffset + layoutLaneYStep
          );
          maxChildX = Math.max(maxChildX, laneX + LANE_NODE_WIDTH + 40);
          maxChildX = Math.max(
            maxChildX,
            sessionX + SESSION_NODE_WIDTH + 48
          );
        }

        const hiddenSubAgentCount =
          collapsedTopology.hiddenByParent.get(row.thread.id) ?? 0;
        if (hiddenSubAgentCount > 0) {
          const collapseNodeId = `collapsed:${row.thread.id}`;
          const collapseY = rowBottomY + 16;
          projectNodes.push({
            id: collapseNodeId,
            position: { x: threadX + layoutLaneXOffset, y: collapseY },
            data: {
              label: toMetaLabel({
                title: `+${hiddenSubAgentCount} older sub-agent threads`,
                subtitle: "collapsed for readability",
              }),
            },
            parentId: projectId,
            extent: "parent",
            selectable: false,
            draggable: false,
            style: {
              ...baseNodeStyle,
              width: 250,
              background: "#111114",
              border: "1px dashed #52525b",
            },
          });
          projectEdges.push({
            id: `collapsed-edge:${row.thread.id}`,
            source: threadNodeId,
            target: collapseNodeId,
            style: {
              stroke: "#52525b",
              strokeWidth: 1,
              strokeDasharray: "5 4",
            },
          });
          rowBottomY = Math.max(rowBottomY, collapseY + 64);
          maxChildX = Math.max(maxChildX, threadX + layoutLaneXOffset + 286);
        }

        cursorY = rowBottomY + layoutThreadToThreadGap;
      }

      const groupWidth = Math.max(
        layoutProjectColumnWidth - 36,
        maxChildX + 16
      );
      const groupHeight = Math.max(
        PROJECT_NODE_BASE_HEIGHT,
        cursorY + PROJECT_PADDING_Y
      );
      const projectLiveThreadCount = projectRows.filter((row) =>
        liveThreadIds.has(row.thread.id)
      ).length;
      const projectSummarySubtitle = `${projectRows.length} threads · ${projectLanes.length} lanes · ${projectRunningSessionCount} sessions · ${projectAgentCount} agents${projectProblemLaneCount > 0 ? ` · ${projectProblemLaneCount} issues` : ""}`;
      projectSummaries.push({
        projectId,
        projectName,
        threadCount: projectRows.length,
        laneCount: projectLanes.length,
        sessionCount: projectRunningSessionCount,
        agentCount: projectAgentCount,
        problemLaneCount: projectProblemLaneCount,
        liveThreadCount: projectLiveThreadCount,
      });

      nodes.push({
        id: projectId,
        type: "group",
        position: { x: projectX, y: 16 },
        data: {
          label: toMetaLabel({
            title: projectName,
            subtitle: projectSummarySubtitle,
          }),
        },
        style: {
          ...groupNodeStyle,
          width: groupWidth,
          height: groupHeight,
        },
        selectable: false,
        draggable: false,
      });

      nodes.push({
        id: `project-label:${projectId}`,
        parentId: projectId,
        selectable: false,
        draggable: false,
        position: { x: PROJECT_PADDING_X, y: 8 },
        style: {
          width: 560,
          border: "none",
          background: "transparent",
          color: "#e4e4e7",
          boxShadow: "none",
        },
        data: {
          label: toMetaLabel({
            title: projectName,
            subtitle: projectSummarySubtitle,
          }),
        },
      });

      nodes.push(...projectNodes);
      edges.push(...projectEdges);
    }

    return {
      nodes,
      edges,
      projectOrder,
      projectSummaries,
      missingParentEdgeCount,
    };
  }, [
    collapsedTopology,
    laneByThread,
    layoutPreset,
    runningSessionByLaneId,
    liveThreadIds,
    snapshot?.lanes,
    snapshot?.webhooks,
    viewMode,
  ]);

  const collapsedCount = useMemo(
    () =>
      [...collapsedTopology.hiddenByParent.values()].reduce(
        (sum, value) => sum + value,
        0
      ),
    [collapsedTopology.hiddenByParent]
  );
  const unresolvedParentCount =
    snapshot?.topologyDiagnostics.unresolvedParentIds.length ?? 0;
  const selectedNodes = useMemo(
    () =>
      flowGraph.nodes.filter((node) => selectedNodeIds.includes(String(node.id))),
    [flowGraph.nodes, selectedNodeIds]
  );
  const selectedThreadIds = useMemo(
    () =>
      selectedNodes
        .filter((node) => node.id.startsWith("thread:"))
        .map((node) => node.id.replace("thread:", "")),
    [selectedNodes]
  );
  const selectedLaneIds = useMemo(
    () =>
      selectedNodes
        .filter((node) => node.id.startsWith("lane:"))
        .map((node) => node.id.replace("lane:", "")),
    [selectedNodes]
  );
  const nodeById = useMemo(
    () => new Map(flowGraph.nodes.map((node) => [node.id, node])),
    [flowGraph.nodes]
  );
  const allProjectSummaries = useMemo(
    () => buildProjectSummaries({ snapshot }),
    [snapshot]
  );
  const renderedProjectNames = useMemo(
    () => new Set(flowGraph.projectSummaries.map((project) => project.projectName)),
    [flowGraph.projectSummaries]
  );
  const filteredProjectSummaries = useMemo(() => {
    const lowered = projectFilterQuery.trim().toLowerCase();
    if (!lowered) {
      return allProjectSummaries;
    }
    return allProjectSummaries.filter((project) =>
      project.projectName.toLowerCase().includes(lowered)
    );
  }, [allProjectSummaries, projectFilterQuery]);

  const resolveNodeGlobalBox = useCallback(
    ({ nodeId }: { nodeId: string }) => {
      const node = nodeById.get(nodeId);
      if (!node) {
        return null;
      }
      let x = node.position.x;
      let y = node.position.y;
      let parentId = node.parentId;
      while (parentId) {
        const parent = nodeById.get(parentId);
        if (!parent) {
          break;
        }
        x += parent.position.x;
        y += parent.position.y;
        parentId = parent.parentId;
      }
      const width =
        typeof node.style?.width === "number" ? node.style.width : THREAD_NODE_WIDTH;
      const height =
        typeof node.style?.height === "number"
          ? node.style.height
          : THREAD_NODE_MIN_HEIGHT;
      return { x, y, width, height };
    },
    [nodeById]
  );

  const focusGraphNode = useCallback(
    ({ nodeId }: { nodeId: string }) => {
      if (!reactFlowInstance) {
        return;
      }
      const box = resolveNodeGlobalBox({ nodeId });
      if (!box) {
        return;
      }
      reactFlowInstance.setCenter(box.x + box.width / 2, box.y + box.height / 2, {
        zoom: 0.98,
        duration: 320,
      });
    },
    [reactFlowInstance, resolveNodeGlobalBox]
  );

  const focusSelectedNodes = useCallback(() => {
    if (!reactFlowInstance || selectedNodeIds.length === 0) {
      return;
    }
    const boxes = selectedNodeIds
      .map((nodeId) => resolveNodeGlobalBox({ nodeId }))
      .filter((box): box is NonNullable<typeof box> => box !== null);
    if (boxes.length === 0) {
      return;
    }
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    const centerX = minX + (maxX - minX) / 2;
    const centerY = minY + (maxY - minY) / 2;
    const width = Math.max(180, maxX - minX);
    const height = Math.max(140, maxY - minY);
    const zoom = Math.min(
      1.35,
      Math.max(0.35, Math.min(1400 / (width + 260), 820 / (height + 240)))
    );
    reactFlowInstance.setCenter(centerX, centerY, { zoom, duration: 320 });
  }, [reactFlowInstance, resolveNodeGlobalBox, selectedNodeIds]);

  const archiveSelectedThreads = async () => {
    if (selectedThreadIds.length === 0) {
      return;
    }
    setPendingActionKey("topology-bulk-thread-archive");
    setActionError(null);
    setActionMessage(null);
    let successCount = 0;
    const failed: string[] = [];
    for (const threadId of selectedThreadIds) {
      try {
        await runDashboardAction({
          payload: { action: "thread-archive", threadId },
        });
        successCount += 1;
      } catch {
        failed.push(threadId);
      }
    }
    if (successCount > 0) {
      setActionMessage(`Archived ${successCount} thread(s).`);
    }
    if (failed.length > 0) {
      const sample = failed.slice(0, 2).join(", ");
      setActionError(
        `Failed to archive ${failed.length} thread(s)${sample ? `: ${sample}` : ""}`
      );
    }
    await refreshSnapshot({ isPoll: false }).catch(() => undefined);
    setSelectedNodeIds([]);
    setArchiveThreadsArmed(false);
    setPendingActionKey(null);
  };

  const deleteSelectedLanes = async () => {
    if (selectedLaneIds.length === 0) {
      return;
    }
    setPendingActionKey("topology-bulk-lane-delete");
    setActionError(null);
    setActionMessage(null);
    let successCount = 0;
    const failed: string[] = [];
    for (const laneId of selectedLaneIds) {
      try {
        await runDashboardAction({
          payload: { action: "lane-delete", laneId },
        });
        successCount += 1;
      } catch {
        failed.push(laneId);
      }
    }
    if (successCount > 0) {
      setActionMessage(`Deleted ${successCount} lane(s).`);
    }
    if (failed.length > 0) {
      const sample = failed.slice(0, 2).join(", ");
      setActionError(
        `Failed to delete ${failed.length} lane(s)${sample ? `: ${sample}` : ""}`
      );
    }
    await refreshSnapshot({ isPoll: false }).catch(() => undefined);
    setSelectedNodeIds([]);
    setDeleteLanesArmed(false);
    setPendingActionKey(null);
  };

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target;
      const isTypingTarget =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandPaletteOpen((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        setIsCommandPaletteOpen(false);
        setArchiveThreadsArmed(false);
        setDeleteLanesArmed(false);
        return;
      }
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isTypingTarget) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        if (selectedNodeIds.length > 0) {
          focusSelectedNodes();
        } else {
          reactFlowInstance?.fitView({
            duration: 300,
            maxZoom: 2.4,
            padding: 0.08,
          });
        }
        return;
      }
      if (key === "o") {
        applyTopologyModePreset({ mode: "ops" });
        return;
      }
      if (key === "d") {
        applyTopologyModePreset({ mode: "debug" });
        return;
      }
      if (key === "a") {
        applyTopologyModePreset({ mode: "audit" });
        return;
      }
      if (key === "l") {
        setLiveOnly((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [
    applyTopologyModePreset,
    focusSelectedNodes,
    reactFlowInstance,
    selectedNodeIds.length,
  ]);

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl">Topology</h1>
          <p className="text-sm text-zinc-400">
            Project-grouped graph of thread lineage, lanes, sessions, and
            effective webhook scope.
          </p>
        </div>
        <ActionButton
          busy={isRefreshing}
          icon={
            <RefreshCw
              className={isRefreshing ? "animate-spin" : ""}
              size={14}
            />
          }
          label={isRefreshing ? "Refreshing..." : "Refresh"}
          onClick={() => {
            refreshSnapshot({ isPoll: false }).catch(() => undefined);
          }}
        />
      </header>

      {error ? <Banner text={error} tone="error" /> : null}
      {actionError ? <Banner text={actionError} tone="error" /> : null}
      {actionMessage ? <Banner text={actionMessage} tone="success" /> : null}

      <Panel
        description={
          topologyMode === "ops"
            ? "Ops mode prioritizes active and problematic work. Hierarchy maps Project → Thread → Session → Lane, with sub-agents indented by depth."
            : topologyMode === "audit"
              ? "Audit mode emphasizes orphaned parents, sub-agent lineages, and degraded lanes for structure validation."
              : "Debug mode shows full context across projects. Missing parents usually indicate ancestor threads outside the loaded codex snapshot."
        }
        title={`Agent Topology (${flowGraph.nodes.length} nodes)`}
      >
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            mode
            <select
              className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              onChange={(event) =>
                applyTopologyModePreset({
                  mode: event.target.value as TopologyMode,
                })
              }
              value={topologyMode}
            >
              <option value="ops">ops</option>
              <option value="debug">debug</option>
              <option value="audit">audit</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            scope
            <select
              className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              onChange={(event) =>
                setViewMode(event.target.value as "focused" | "all")
              }
              value={viewMode}
            >
              <option value="focused">focused (active + attached)</option>
              <option value="all">all threads</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            layout
            <select
              className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              onChange={(event) =>
                setLayoutPreset(event.target.value as "compact" | "roomy")
              }
              value={layoutPreset}
            >
              <option value="compact">compact</option>
              <option value="roomy">roomy</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            max threads
            <input
              className="h-8 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              max={500}
              min={10}
              onChange={(event) => setMaxThreads(Number(event.target.value))}
              type="number"
              value={maxThreads}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            stale filter
            <input
              checked={hideStaleThreads}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
              onChange={(event) => setHideStaleThreads(event.target.checked)}
              type="checkbox"
            />
            <span>hide dead</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            live only
            <input
              checked={liveOnly}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
              onChange={(event) => setLiveOnly(event.target.checked)}
              type="checkbox"
            />
            <span>active now</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            stale hours
            <input
              className="h-8 w-20 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              max={168}
              min={1}
              onChange={(event) =>
                setStaleThreadHours(Number(event.target.value))
              }
              type="number"
              value={staleThreadHours}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            cleanup hours
            <input
              className="h-8 w-20 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              max={168}
              min={1}
              onChange={(event) => {
                setCleanupHours(Number(event.target.value));
                setCleanupArmed(false);
              }}
              type="number"
              value={cleanupHours}
            />
            <ActionButton
              busy={pendingActionKey === "topology-lane-cleanup"}
              icon={<Trash2 size={12} />}
              label={cleanupArmed ? "Confirm cleanup" : "Cleanup stale lanes"}
              onClick={() => {
                if (!cleanupArmed) {
                  setCleanupArmed(true);
                  return;
                }
                runAction({
                  actionKey: "topology-lane-cleanup",
                  successMessage: "Stale lanes cleaned up",
                  payload: {
                    action: "lane-cleanup",
                    statuses: ["blocked", "done", "failed", "interrupted"],
                    olderThanHours: cleanupHours,
                    syntheticOnly: false,
                    limit: 500,
                  },
                })
                  .catch(() => undefined)
                  .finally(() => setCleanupArmed(false));
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            sub-agent cap / parent
            <input
              className="h-8 w-20 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
              max={50}
              min={1}
              onChange={(event) =>
                setMaxSubAgentsPerParent(Number(event.target.value))
              }
              type="number"
              value={maxSubAgentsPerParent}
            />
          </label>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            mode: {topologyMode}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            showing {collapsedTopology.rows.length} thread rows
          </span>
          <span
            className={`rounded border px-2 py-1 ${
              liveOnly
                ? "border-cyan-600/50 bg-cyan-950/30 text-cyan-100"
                : "border-zinc-700 bg-zinc-900"
            }`}
          >
            live threads now: {liveThreadIds.size}
          </span>
          {collapsedTopology.hiddenByThreadCap > 0 ? (
            <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
              hidden by max thread cap: {collapsedTopology.hiddenByThreadCap}
            </span>
          ) : null}
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            collapsed sub-agent branches: {collapsedCount}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            unresolved parent refs (snapshot): {unresolvedParentCount}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            unresolved parent links (rendered): {flowGraph.missingParentEdgeCount}
          </span>
          {cleanupArmed ? (
            <span className="rounded border border-amber-600/50 bg-amber-950/30 px-2 py-1 text-amber-200">
              cleanup armed: click confirm cleanup to proceed
            </span>
          ) : null}
        </div>

        <div className="sticky top-2 z-10 mb-3 rounded-lg border border-zinc-700/80 bg-zinc-900/95 p-3 backdrop-blur">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
            <span>
              project rail · all projects {allProjectSummaries.length} · visible in graph{" "}
              {flowGraph.projectSummaries.length}
            </span>
            <div className="flex items-center gap-2">
              <input
                className="h-8 w-48 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100"
                onChange={(event) => setProjectFilterQuery(event.target.value)}
                placeholder="Filter projects..."
                type="search"
                value={projectFilterQuery}
              />
              <button
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                onClick={() =>
                  reactFlowInstance?.fitView({
                    duration: 280,
                    maxZoom: 2.4,
                    padding: 0.08,
                  })
                }
                type="button"
              >
                fit all
              </button>
              <button
                className="rounded border border-cyan-700/60 bg-cyan-950/20 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-950/35"
                onClick={() => {
                  applyTopologyModePreset({ mode: "debug" });
                  setSearch("");
                  setLiveOnly(false);
                }}
                type="button"
              >
                show all projects
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {filteredProjectSummaries.map((project) => {
              const isRenderedProject = renderedProjectNames.has(
                project.projectName
              );
              return (
              <button
                className={`rounded border px-2 py-1 text-left text-xs transition ${
                  !isRenderedProject
                    ? "border-dashed border-cyan-700/60 bg-cyan-950/15 text-cyan-100 hover:bg-cyan-950/25"
                    : project.problemLaneCount > 0
                    ? "border-amber-600/60 bg-amber-950/25 text-amber-100 hover:bg-amber-950/40"
                    : "border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800"
                }`}
                key={project.projectId}
                onClick={() => {
                  const projectNodeId = `project:${project.projectName}`;
                  if (isRenderedProject && nodeById.has(projectNodeId)) {
                    focusGraphNode({ nodeId: projectNodeId });
                    return;
                  }
                  applyTopologyModePreset({ mode: "debug" });
                  setLiveOnly(false);
                  setSearch(project.projectName);
                  setActionMessage(
                    `Switched to debug mode and filtered by project ${project.projectName}`
                  );
                }}
                type="button"
              >
                <div className="font-medium">{project.projectName}</div>
                <div className="mono text-[11px] text-zinc-400">
                  t {project.threadCount} · l {project.laneCount} · s{" "}
                  {project.sessionCount} · a {project.agentCount} · live{" "}
                  {project.liveThreadCount}
                  {project.problemLaneCount > 0
                    ? ` · issues ${project.problemLaneCount}`
                    : ""}
                </div>
                {!isRenderedProject ? (
                  <div className="mt-1 text-[11px] text-cyan-300">
                    outside current graph filter
                  </div>
                ) : null}
              </button>
              );
            })}
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            selected nodes {selectedNodes.length}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            threads {selectedThreadIds.length} · lanes {selectedLaneIds.length}
          </span>
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-45"
            disabled={selectedNodes.length === 0}
            onClick={focusSelectedNodes}
            type="button"
          >
            focus selected (F)
          </button>
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-45"
            disabled={selectedThreadIds.length === 0}
            onClick={() => {
              if (!archiveThreadsArmed) {
                setArchiveThreadsArmed(true);
                return;
              }
              archiveSelectedThreads().catch(() => undefined);
            }}
            type="button"
          >
            {archiveThreadsArmed ? "confirm archive threads" : "archive threads"}
          </button>
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-45"
            disabled={selectedLaneIds.length === 0}
            onClick={() => {
              if (!deleteLanesArmed) {
                setDeleteLanesArmed(true);
                return;
              }
              deleteSelectedLanes().catch(() => undefined);
            }}
            type="button"
          >
            {deleteLanesArmed ? "confirm delete lanes" : "delete lanes"}
          </button>
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
            onClick={() => setIsCommandPaletteOpen((current) => !current)}
            type="button"
          >
            commands (⌘/Ctrl+K)
          </button>
        </div>

        {isCommandPaletteOpen ? (
          <div className="mb-3 rounded-lg border border-cyan-700/40 bg-cyan-950/20 p-3 text-xs text-cyan-100">
            <div className="mb-2 font-medium">Topology command palette</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() => applyTopologyModePreset({ mode: "ops" })}
                type="button"
              >
                ops mode (O)
              </button>
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() => applyTopologyModePreset({ mode: "debug" })}
                type="button"
              >
                debug mode (D)
              </button>
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() => applyTopologyModePreset({ mode: "audit" })}
                type="button"
              >
                audit mode (A)
              </button>
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() => setLiveOnly((current) => !current)}
                type="button"
              >
                live only (L)
              </button>
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() =>
                  reactFlowInstance?.fitView({
                    duration: 280,
                    maxZoom: 2.4,
                    padding: 0.08,
                  })
                }
                type="button"
              >
                fit graph
              </button>
              <button
                className="rounded border border-cyan-600/40 bg-cyan-950/30 px-2 py-1 hover:bg-cyan-900/40"
                onClick={() => {
                  searchInputRef.current?.focus();
                  setIsCommandPaletteOpen(false);
                }}
                type="button"
              >
                focus search (/)
              </button>
            </div>
          </div>
        ) : null}

        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            <Layers size={12} /> project
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            <Activity size={12} /> thread
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-violet-700/60 bg-violet-950/30 px-2 py-1 text-violet-200">
            sub-agent thread
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            session
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            lane
          </span>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            hierarchy: Project → Thread → Session → Lane
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            ownership: lane belongs to thread; running session belongs to lane
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            edge semantics: dashed = degraded/missing ancestry, animated = live work
          </span>
        </div>

        <div className="mb-3">
          <label className="flex h-9 min-w-[340px] items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100">
            <Search className="text-zinc-500" size={14} />
            <input
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search project, thread, lane, source..."
              ref={searchInputRef}
              type="search"
              value={search}
            />
          </label>
        </div>

        {isLoading && !snapshot ? (
          <p className="text-sm text-zinc-400">Loading topology...</p>
        ) : flowGraph.nodes.length === 0 ? (
          <EmptyState text="No topology nodes found for this filter." />
        ) : (
          <div className="relative h-[76vh] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
            <ReactFlow
              edges={flowGraph.edges}
              fitView
              fitViewOptions={{ padding: 0.08, maxZoom: 2.4 }}
              nodes={flowGraph.nodes}
              onInit={setReactFlowInstance}
              onNodeClick={(_, node) => {
                const meta = (node.data as { meta?: TopologyMeta }).meta;
                setSelectedNode(meta ?? null);
                setSelectedNodeIds([String(node.id)]);
                setArchiveThreadsArmed(false);
                setDeleteLanesArmed(false);
              }}
              onPaneClick={() => {
                setSelectedNode(null);
                setSelectedNodeIds([]);
                setArchiveThreadsArmed(false);
                setDeleteLanesArmed(false);
              }}
              onSelectionChange={({ nodes }) => {
                const nextNodeIds = nodes.map((node) => String(node.id));
                setSelectedNodeIds((current) => {
                  if (
                    current.length === nextNodeIds.length &&
                    current.every((nodeId, index) => nodeId === nextNodeIds[index])
                  ) {
                    return current;
                  }
                  return nextNodeIds;
                });
                setArchiveThreadsArmed(false);
                setDeleteLanesArmed(false);
              }}
              selectionOnDrag
            >
              <MiniMap
                maskColor="rgba(10,10,12,0.6)"
                nodeColor={(node) =>
                  miniMapNodeColor({
                    node: node as Node<{ label: ReactNode; meta?: TopologyMeta }>,
                  })
                }
                pannable
                style={{
                  backgroundColor: "#09090b",
                  border: "1px solid #3f3f46",
                }}
                zoomable
              />
              <Controls className="border-zinc-700! bg-zinc-900!" />
              <Background color="#27272a" gap={20} size={1} />
            </ReactFlow>

            <AnimatePresence>
              {selectedNode ? (
                <motion.aside
                  animate={{ x: 0, opacity: 1 }}
                  className="absolute inset-y-3 right-3 w-[340px] rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 shadow-2xl shadow-black/45 backdrop-blur-md"
                  exit={{ x: 280, opacity: 0 }}
                  initial={{ x: 280, opacity: 0 }}
                  transition={{
                    type: "spring",
                    stiffness: 330,
                    damping: 26,
                    mass: 0.7,
                  }}
                >
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <p className="mono text-xs text-zinc-500 uppercase tracking-[0.18em]">
                        {selectedNode.kind}
                      </p>
                      <h3 className="mt-1 font-semibold text-sm text-zinc-100">
                        {selectedNode.title}
                      </h3>
                      <p className="text-xs text-zinc-500">
                        {selectedNode.subtitle}
                      </p>
                    </div>
                    <button
                      className="rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700"
                      onClick={() => setSelectedNode(null)}
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <dl className="space-y-2 text-sm">
                    {selectedNode.details.map((item) => (
                      <div
                        className="rounded-md bg-zinc-950/70 px-3 py-2"
                        key={`${selectedNode.id}:${item.label}`}
                      >
                        <dt className="text-[11px] text-zinc-500 uppercase tracking-wide">
                          {item.label}
                        </dt>
                        <dd className="mono mt-1 text-xs text-zinc-200">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-4 flex items-center justify-between">
                    <Link
                      className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
                      href={selectedNode.href}
                    >
                      <Activity size={13} />
                      open details
                    </Link>
                    {selectedNode.kind === "lane" ? (
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${laneStatusClassName(
                          {
                            status: selectedNode.status ?? "idle",
                          }
                        )}`}
                      >
                        {selectedNode.status ?? "unknown"}
                      </span>
                    ) : null}
                  </div>
                </motion.aside>
              ) : null}
            </AnimatePresence>
          </div>
        )}
      </Panel>
    </div>
  );
}
