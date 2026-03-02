import type { DashboardSnapshot, DashboardThread } from "@/lib/dashboard-data"

const PROBLEM_LANE_STATUSES = new Set(["needs_approval", "blocked", "failed", "interrupted"])

const resolveProjectName = ({ value }: { value?: string | null }): string =>
  typeof value === "string" && value.trim().length > 0 ? value : "Unassigned"

const isSubAgentThread = ({ thread }: { thread: DashboardThread }): boolean =>
  thread.sourceKind.startsWith("subAgent") || thread.sourceGroup.includes("sub-agent")

interface MutableProjectSummary {
  projectId: string
  projectName: string
  threadIds: Set<string>
  laneIds: Set<string>
  sessionIds: Set<string>
  agentCount: number
  problemLaneCount: number
  liveThreadCount: number
}

export interface DashboardProjectSummary {
  projectId: string
  projectName: string
  threadCount: number
  laneCount: number
  sessionCount: number
  agentCount: number
  problemLaneCount: number
  liveThreadCount: number
}

export const buildProjectSummaries = ({
  snapshot,
}: {
  snapshot: DashboardSnapshot | null | undefined
}): DashboardProjectSummary[] => {
  if (!snapshot) {
    return []
  }

  const threadById = new Map(snapshot.threads.map((thread) => [thread.id, thread]))
  const laneById = new Map(snapshot.lanes.map((lane) => [lane.laneId, lane]))
  const liveThreadIds = new Set(snapshot.activeThreads.map((thread) => thread.id))
  for (const laneSession of snapshot.laneSessions) {
    if (laneSession.running && laneSession.threadId) {
      liveThreadIds.add(laneSession.threadId)
    }
  }

  const summaryByProject = new Map<string, MutableProjectSummary>()
  const ensureProjectSummary = ({ projectName }: { projectName: string }): MutableProjectSummary => {
    const existing = summaryByProject.get(projectName)
    if (existing) {
      return existing
    }
    const created: MutableProjectSummary = {
      projectId: `project:${projectName}`,
      projectName,
      threadIds: new Set<string>(),
      laneIds: new Set<string>(),
      sessionIds: new Set<string>(),
      agentCount: 0,
      problemLaneCount: 0,
      liveThreadCount: 0,
    }
    summaryByProject.set(projectName, created)
    return created
  }

  for (const thread of snapshot.threads) {
    const projectName = resolveProjectName({ value: thread.projectName })
    const summary = ensureProjectSummary({ projectName })
    if (!summary.threadIds.has(thread.id)) {
      summary.threadIds.add(thread.id)
      if (isSubAgentThread({ thread })) {
        summary.agentCount += 1
      }
    }
    if (liveThreadIds.has(thread.id)) {
      summary.liveThreadCount += 1
    }
  }

  for (const lane of snapshot.lanes) {
    const linkedThread = lane.threadId ? threadById.get(lane.threadId) ?? null : null
    const projectName = resolveProjectName({
      value: lane.projectName ?? linkedThread?.projectName ?? null,
    })
    const summary = ensureProjectSummary({ projectName })
    summary.laneIds.add(lane.laneId)
    if (PROBLEM_LANE_STATUSES.has(lane.status)) {
      summary.problemLaneCount += 1
    }
  }

  for (const laneSession of snapshot.laneSessions) {
    if (!laneSession.running) {
      continue
    }
    const linkedThread = laneSession.threadId ? threadById.get(laneSession.threadId) ?? null : null
    const linkedLane = laneById.get(laneSession.laneId) ?? null
    const projectName = resolveProjectName({
      value: linkedThread?.projectName ?? linkedLane?.projectName ?? null,
    })
    const summary = ensureProjectSummary({ projectName })
    summary.sessionIds.add(laneSession.laneId)
  }

  return [...summaryByProject.values()]
    .map((summary): DashboardProjectSummary => ({
      projectId: summary.projectId,
      projectName: summary.projectName,
      threadCount: summary.threadIds.size,
      laneCount: summary.laneIds.size,
      sessionCount: summary.sessionIds.size,
      agentCount: summary.agentCount,
      problemLaneCount: summary.problemLaneCount,
      liveThreadCount: summary.liveThreadCount,
    }))
    .sort(
      (left, right) =>
        right.liveThreadCount - left.liveThreadCount ||
        right.problemLaneCount - left.problemLaneCount ||
        right.threadCount + right.laneCount + right.sessionCount - (left.threadCount + left.laneCount + left.sessionCount) ||
        left.projectName.localeCompare(right.projectName)
    )
}
