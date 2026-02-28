const DEFAULT_BRIDGE_BASE_URL = "https://codex-gateway.hack.gy"
const BRIDGE_TIMEOUT_MS = 3000
const BRIDGE_TIMEOUT_MS_CODEX_THREADS = 8000
const BRIDGE_TIMEOUT_MS_CODEX_THREAD_DETAIL = 2500
const BRIDGE_TIMEOUT_MS_CODEX_RUNNING = 9000
const BRIDGE_TIMEOUT_MS_EVENTS = 1600
const CODEX_THREADS_LIST_LIMIT = 200
const MAX_PARENT_THREAD_RESOLVE_DEPTH = 4
const MAX_PARENT_THREAD_RESOLVE_COUNT = 320
const MAX_EVENT_LANE_COUNT = 20
const MAX_ISSUE_COUNT = 120

type LaneStatus =
  | "idle"
  | "starting"
  | "running"
  | "needs_approval"
  | "blocked"
  | "verifying"
  | "done"
  | "failed"
  | "interrupted"

type EventSeverity = "info" | "warn" | "error"

interface HealthResponse {
  ok: boolean
  service: string
  version: string
  codexAppServerVersion: string
  codexBin: string
  codexAppServerWsUrl: string | null
  lanes: number
  watcher: {
    running: boolean
    intervalSec: number
  }
  defaultSurfacePolicy: string
}

interface WatchStatusResponse {
  running: boolean
  intervalSec: number
}

interface Lane {
  laneId: string
  threadId?: string
  repoRoot?: string
  projectId?: string
  status: LaneStatus
  activeTurnId?: string
  readinessMode?: "strict" | "lenient"
  preferredSurface?: "mac-app" | "vscode" | "cli" | "any"
  surface?: "mac-app" | "vscode" | "cli" | "unknown"
  createdAt: string
  updatedAt: string
}

export interface DashboardLane extends Lane {
  projectName: string | null
  displayName: string
  shortId: string
  ownershipType: "thread-owned" | "project-owned" | "unbound"
  ownershipLabel: string
  ownerRef: string | null
}

interface LaneEvent {
  eventId: string
  laneId: string
  type: string
  ts: string
  severity: EventSeverity
  payload?: Record<string, unknown>
}

interface WebhookSubscription {
  id: string
  url: string
  enabled: boolean
  events: string[]
  scope?: {
    laneIds: string[]
    threadIds: string[]
    sessionIds: string[]
  }
  scopeKinds?: string[]
  updatedAt: string
  createdAt: string
  lastDeliveryAt?: string
  lastError?: string
}

interface RawCodexThread {
  id: string
  source?: unknown
  surface?: "mac-app" | "vscode" | "cli" | "unknown"
  updatedAt?: number
  cwd?: string
  originator?: string | null
  title?: string | null
  preview?: string
}

interface RunningSession {
  pid?: number
  threadId?: string
  source?: unknown
  originator?: string | null
  cwd?: string
  path?: string
  command?: string
}

export interface DashboardThread extends RawCodexThread {
  projectName: string | null
  displayName: string
  shortId: string
  sourceKind: string
  sourceGroup: string
  sourceLabel: string
  sourceDetail: string | null
  sourceParentThreadId: string | null
  sourceAgentNickname: string | null
  sourceAgentRole: string | null
  sourceDepth: number | null
}

export interface DashboardRunningSession extends RunningSession {
  projectName: string | null
  displayName: string
  shortId: string
  sourceKind: string
  sourceGroup: string
  sourceLabel: string
  sourceDetail: string | null
}

export interface LaneSessionSnapshot {
  laneId: string
  threadId: string | null
  running: boolean
  startedAt: string | null
  pendingRequests: number
  activeTurnId: string | null
  readinessMode: "strict" | "lenient"
  readinessDeferred: boolean
  readinessReason: string | null
}

interface LanesResponse {
  lanes: Lane[]
}

interface LaneEventsResponse {
  events: LaneEvent[]
}

interface WebhooksResponse {
  subscriptions: WebhookSubscription[]
}

interface ThreadsResponse {
  threads: RawCodexThread[]
  count: number
}

interface ThreadByIdResponse {
  thread: RawCodexThread
}

interface RunningSessionsResponse {
  sessions: RunningSession[]
  count: number
  detectionMode?: string
  inferred?: boolean
  inferredWindowSec?: number
}

interface LaneSessionsResponse {
  sessions: LaneSessionSnapshot[]
  count: number
  runningCount: number
}

interface CountByLabel {
  label: string
  count: number
}

export interface DashboardRequestError {
  endpoint: string
  message: string
  statusCode?: number
}

export interface DashboardIssue {
  id: string
  source: "event" | "lane" | "webhook" | "request"
  severity: EventSeverity
  laneId: string | null
  type: string
  message: string
  ts: string
}

interface DashboardStats {
  lanesTotal: number
  lanesRunning: number
  lanesBlocked: number
  lanesNeedsApproval: number
  lanesFailed: number
  webhooksTotal: number
  webhooksEnabled: number
  webhooksWithErrors: number
  threadsTotal: number
  activeThreads: number
  runningSessions: number
}

interface DashboardDistributions {
  lanesByStatus: CountByLabel[]
  threadsBySource: CountByLabel[]
  threadsBySurface: CountByLabel[]
  activeThreadsBySource: CountByLabel[]
}

interface DashboardConnections {
  bridgeHealthy: boolean
  watcherRunning: boolean
  codexThreadEndpointReachable: boolean
  codexRunningEndpointReachable: boolean
  hasActiveThreads: boolean
  hasRunningCodexSessions: boolean
}

interface DashboardTopologyDiagnostics {
  unresolvedParentIds: string[]
}

interface DashboardRunningDetection {
  detectionMode: string
  inferred: boolean
  inferredWindowSec: number | null
}

export interface DashboardSnapshot {
  generatedAt: string
  bridgeBaseUrl: string
  health: HealthResponse | null
  watch: WatchStatusResponse | null
  lanes: DashboardLane[]
  laneSessions: LaneSessionSnapshot[]
  webhooks: WebhookSubscription[]
  threads: DashboardThread[]
  activeThreads: DashboardThread[]
  runningSessions: DashboardRunningSession[]
  runningDetection: DashboardRunningDetection
  laneEvents: LaneEvent[]
  issues: DashboardIssue[]
  requestErrors: DashboardRequestError[]
  topologyDiagnostics: DashboardTopologyDiagnostics
  stats: DashboardStats
  distributions: DashboardDistributions
  connections: DashboardConnections
}

type EndpointResult<TData> =
  | {
      ok: true
      data: TData
    }
  | {
      ok: false
      error: DashboardRequestError
    }

const normalizeBaseUrl = ({ baseUrl }: { baseUrl: string }): string =>
  baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl

export const resolveBridgeBaseUrl = (): string => {
  const envValue = process.env.BRIDGE_BASE_URL?.trim()
  if (envValue && envValue.length > 0) {
    return normalizeBaseUrl({ baseUrl: envValue })
  }
  return DEFAULT_BRIDGE_BASE_URL
}

const endpointUrl = ({
  baseUrl,
  endpoint,
}: {
  baseUrl: string
  endpoint: string
}): string => `${baseUrl}${endpoint}`

const extractErrorMessage = ({
  body,
  fallback,
}: {
  body: string
  fallback: string
}): string => {
  const trimmed = body.trim()
  if (!trimmed) {
    return fallback
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed
}

const errorMessageWithCause = ({ error }: { error: unknown }): string => {
  if (!(error instanceof Error)) {
    return "unknown_error"
  }
  if (!("cause" in error)) {
    return error.message
  }
  const cause = error.cause
  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`
  }
  return error.message
}

const fetchBridgeJson = async <TData>({
  baseUrl,
  endpoint,
  timeoutMs = BRIDGE_TIMEOUT_MS,
}: {
  baseUrl: string
  endpoint: string
  timeoutMs?: number
}): Promise<EndpointResult<TData>> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  timeout.unref()

  try {
    const response = await fetch(endpointUrl({ baseUrl, endpoint }), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      return {
        ok: false,
        error: {
          endpoint,
          message: extractErrorMessage({
            body: text,
            fallback: `HTTP ${response.status} for ${endpoint}`,
          }),
          statusCode: response.status,
        },
      }
    }

    const data = (await response.json()) as TData
    return { ok: true, data }
  } catch (error) {
    const message = errorMessageWithCause({ error })
    return {
      ok: false,
      error: {
        endpoint,
        message,
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const toNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const truncate = ({ value, maxLength }: { value: string; maxLength: number }): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`

const toTitleCase = ({ value }: { value: string }): string =>
  value
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")

const normalizeIdentifierLabel = ({ value }: { value: string }): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const shortIdentifier = ({ value }: { value: string }): string =>
  value.length > 12 ? `${value.slice(0, 8)}...` : value

const isOpaqueIdentifier = ({ value }: { value: string }): boolean =>
  /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value) ||
  (/^[a-z0-9]+$/i.test(value) && value.length > 18)

const pathBasename = ({ pathValue }: { pathValue: string | null }): string | null => {
  if (!pathValue) {
    return null
  }
  const segments = pathValue
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return null
  }
  return segments[segments.length - 1] ?? null
}

const inferProjectName = ({
  projectId,
  repoRoot,
  cwd,
}: {
  projectId?: string | null
  repoRoot?: string | null
  cwd?: string | null
}): string | null => {
  const explicitProjectId = toNonEmptyString(projectId)
  if (explicitProjectId) {
    return toTitleCase({ value: normalizeIdentifierLabel({ value: explicitProjectId }) })
  }
  const repoName = pathBasename({ pathValue: repoRoot ?? null })
  if (repoName) {
    return toTitleCase({ value: normalizeIdentifierLabel({ value: repoName }) })
  }
  const cwdName = pathBasename({ pathValue: cwd ?? null })
  if (cwdName) {
    return toTitleCase({ value: normalizeIdentifierLabel({ value: cwdName }) })
  }
  return null
}

const safeSerialize = ({ value }: { value: unknown }): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

interface ParsedThreadSource {
  kind: string
  group: string
  label: string
  detail: string | null
  parentThreadId: string | null
  agentNickname: string | null
  agentRole: string | null
  depth: number | null
}

const parseThreadSource = ({ source }: { source: unknown }): ParsedThreadSource => {
  if (typeof source === "string") {
    const normalized = source.trim()
    if (!normalized) {
      return {
        kind: "unknown",
        group: "unknown",
        label: "unknown",
        detail: null,
        parentThreadId: null,
        agentNickname: null,
        agentRole: null,
        depth: null,
      }
    }
    return {
      kind: normalized,
      group: normalized,
      label: normalized,
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  if (!isRecord(source)) {
    return {
      kind: "unknown",
      group: "unknown",
      label: "unknown",
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  const subAgent = isRecord(source.subAgent) ? source.subAgent : null
  const threadSpawn = subAgent && isRecord(subAgent.thread_spawn) ? subAgent.thread_spawn : null
  if (threadSpawn) {
    const parentThreadId = toNonEmptyString(threadSpawn.parent_thread_id)
    const agentNickname = toNonEmptyString(threadSpawn.agent_nickname)
    const agentRole = toNonEmptyString(threadSpawn.agent_role)
    const depth = toNumber(threadSpawn.depth)
    const detailParts = [
      parentThreadId ? `parent ${truncate({ value: parentThreadId, maxLength: 16 })}` : null,
      depth !== null ? `depth ${depth}` : null,
      agentRole ? `role ${agentRole}` : null,
    ].filter((value): value is string => value !== null)
    return {
      kind: "subAgentThreadSpawn",
      group: "sub-agent spawn",
      label: agentNickname ? `sub-agent ${agentNickname}` : "sub-agent spawn",
      detail: detailParts.length > 0 ? detailParts.join(" • ") : null,
      parentThreadId,
      agentNickname,
      agentRole,
      depth,
    }
  }

  if (subAgent && subAgent.review !== undefined) {
    return {
      kind: "subAgentReview",
      group: "sub-agent review",
      label: "sub-agent review",
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  if (subAgent && subAgent.compact !== undefined) {
    return {
      kind: "subAgentCompact",
      group: "sub-agent compact",
      label: "sub-agent compact",
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  if (subAgent) {
    return {
      kind: "subAgentOther",
      group: "sub-agent",
      label: "sub-agent",
      detail: truncate({ value: safeSerialize({ value: subAgent }), maxLength: 140 }),
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  if (source.appServer !== undefined) {
    return {
      kind: "appServer",
      group: "app-server",
      label: "app-server",
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  if (source.exec !== undefined) {
    return {
      kind: "exec",
      group: "exec",
      label: "exec",
      detail: null,
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      depth: null,
    }
  }

  const keys = Object.keys(source)
  const fallbackLabel = keys[0] ?? "unknown"
  return {
    kind: fallbackLabel,
    group: fallbackLabel,
    label: fallbackLabel,
    detail: truncate({ value: safeSerialize({ value: source }), maxLength: 140 }),
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    depth: null,
  }
}

const enrichLane = ({ lane }: { lane: Lane }): DashboardLane => {
  const projectName = inferProjectName({
    projectId: lane.projectId ?? null,
    repoRoot: lane.repoRoot ?? null,
    cwd: null,
  })
  const ownershipType = lane.threadId
    ? "thread-owned"
    : projectName || lane.projectId || lane.repoRoot
      ? "project-owned"
      : "unbound"
  const ownershipLabel =
    ownershipType === "thread-owned"
      ? "thread-owned"
      : ownershipType === "project-owned"
        ? "project-owned"
        : "unbound"
  const ownerRef =
    ownershipType === "thread-owned"
      ? lane.threadId ?? null
      : ownershipType === "project-owned"
        ? projectName ?? lane.projectId ?? lane.repoRoot ?? null
        : null
  const normalizedLaneId = lane.laneId.startsWith("lane-") ? lane.laneId.slice(5) : lane.laneId
  const laneName = isOpaqueIdentifier({ value: normalizedLaneId })
    ? `Lane ${shortIdentifier({ value: lane.laneId })}`
    : toTitleCase({ value: normalizeIdentifierLabel({ value: normalizedLaneId }) })
  return {
    ...lane,
    projectName,
    displayName: projectName ? `${projectName} · ${laneName}` : laneName,
    shortId: shortIdentifier({ value: lane.laneId }),
    ownershipType,
    ownershipLabel,
    ownerRef,
  }
}

const enrichThread = ({ thread }: { thread: RawCodexThread }): DashboardThread => {
  const parsedSource = parseThreadSource({ source: thread.source })
  const projectName = inferProjectName({
    projectId: null,
    repoRoot: null,
    cwd: thread.cwd ?? null,
  })
  const title = toNonEmptyString(thread.title)
  const displayName = title
    ? title
    : parsedSource.agentNickname
      ? `${parsedSource.agentNickname} agent`
      : projectName
        ? `${projectName} thread`
        : `Thread ${shortIdentifier({ value: thread.id })}`
  return {
    ...thread,
    projectName,
    displayName,
    shortId: shortIdentifier({ value: thread.id }),
    sourceKind: parsedSource.kind,
    sourceGroup: parsedSource.group,
    sourceLabel: parsedSource.label,
    sourceDetail: parsedSource.detail,
    sourceParentThreadId: parsedSource.parentThreadId,
    sourceAgentNickname: parsedSource.agentNickname,
    sourceAgentRole: parsedSource.agentRole,
    sourceDepth: parsedSource.depth,
  }
}

const resolveThreadAncestors = async ({
  baseUrl,
  threads,
}: {
  baseUrl: string
  threads: DashboardThread[]
}): Promise<{
  threads: DashboardThread[]
  unresolvedParentIds: string[]
  requestErrors: DashboardRequestError[]
}> => {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const unresolvedParentIds = new Set<string>()
  const requestErrors: DashboardRequestError[] = []

  let frontier = [
    ...new Set(
      threads
        .map((thread) => thread.sourceParentThreadId)
        .filter((parentId): parentId is string => Boolean(parentId && !threadById.has(parentId)))
    ),
  ]
  let depth = 0

  while (
    frontier.length > 0 &&
    depth < MAX_PARENT_THREAD_RESOLVE_DEPTH &&
    threadById.size < MAX_PARENT_THREAD_RESOLVE_COUNT
  ) {
    const remainingCapacity = Math.max(0, MAX_PARENT_THREAD_RESOLVE_COUNT - threadById.size)
    if (remainingCapacity === 0) {
      break
    }

    const batchParentIds = frontier.slice(0, remainingCapacity)
    const responses = await Promise.all(
      batchParentIds.map((threadId) =>
        fetchBridgeJson<ThreadByIdResponse>({
          baseUrl,
          endpoint: `/codex/threads/${encodeURIComponent(threadId)}`,
          timeoutMs: BRIDGE_TIMEOUT_MS_CODEX_THREAD_DETAIL,
        })
      )
    )

    const nextFrontier = new Set<string>()
    for (const [index, response] of responses.entries()) {
      const requestedThreadId = batchParentIds[index]
      if (!requestedThreadId) {
        continue
      }

      if (!response.ok) {
        if (response.error.statusCode !== 404) {
          requestErrors.push(response.error)
        }
        unresolvedParentIds.add(requestedThreadId)
        continue
      }

      if (!response.data.thread?.id) {
        unresolvedParentIds.add(requestedThreadId)
        continue
      }

      const resolvedThread = enrichThread({ thread: response.data.thread })
      threadById.set(resolvedThread.id, resolvedThread)

      if (resolvedThread.sourceParentThreadId && !threadById.has(resolvedThread.sourceParentThreadId)) {
        nextFrontier.add(resolvedThread.sourceParentThreadId)
      }
    }

    frontier = [...nextFrontier]
    depth += 1
  }

  for (const parentId of frontier) {
    unresolvedParentIds.add(parentId)
  }

  return {
    threads: [...threadById.values()],
    unresolvedParentIds: [...unresolvedParentIds].sort((left, right) => left.localeCompare(right)),
    requestErrors,
  }
}

const enrichRunningSession = ({
  session,
  threadById,
}: {
  session: RunningSession
  threadById: Map<string, DashboardThread>
}): DashboardRunningSession => {
  const parsedSource = parseThreadSource({ source: session.source })
  const linkedThread =
    typeof session.threadId === "string" ? threadById.get(session.threadId) ?? null : null
  const projectName =
    linkedThread?.projectName ??
    inferProjectName({
      projectId: null,
      repoRoot: null,
      cwd: session.cwd ?? session.path ?? null,
    })
  const displayName = linkedThread
    ? `Session · ${linkedThread.displayName}`
    : projectName
      ? `Session · ${projectName}`
      : `Session ${shortIdentifier({ value: String(session.pid ?? session.threadId ?? "unknown") })}`
  return {
    ...session,
    projectName,
    displayName,
    shortId: shortIdentifier({ value: String(session.pid ?? session.threadId ?? "unknown") }),
    sourceKind: parsedSource.kind,
    sourceGroup: parsedSource.group,
    sourceLabel: parsedSource.label,
    sourceDetail: parsedSource.detail,
  }
}

const buildFallbackRunningSessionsFromLaneSessions = ({
  laneSessions,
  laneById,
}: {
  laneSessions: LaneSessionSnapshot[]
  laneById: Map<string, DashboardLane>
}): RunningSession[] => {
  const sessionsByKey = new Map<string, RunningSession>()

  for (const laneSession of laneSessions) {
    if (!laneSession.running) {
      continue
    }
    const lane = laneById.get(laneSession.laneId)
    const threadId = laneSession.threadId ?? lane?.threadId ?? undefined
    const sessionKey = threadId ?? `lane:${laneSession.laneId}`

    if (sessionsByKey.has(sessionKey)) {
      continue
    }

    sessionsByKey.set(sessionKey, {
      threadId,
      cwd: lane?.repoRoot,
      originator: lane?.projectName ?? lane?.projectId ?? null,
      source: "bridgeLaneSession",
    })
  }

  return [...sessionsByKey.values()]
}

const toUnixSeconds = ({ iso }: { iso?: string }): number | undefined => {
  if (!iso) {
    return undefined
  }
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return undefined
  }
  return Math.floor(ms / 1000)
}

const buildFallbackThreadsFromLanes = ({ lanes }: { lanes: DashboardLane[] }): RawCodexThread[] => {
  const laneByThreadId = new Map<string, DashboardLane>()
  for (const lane of lanes) {
    if (!lane.threadId) {
      continue
    }
    const existing = laneByThreadId.get(lane.threadId)
    if (!existing || existing.updatedAt < lane.updatedAt) {
      laneByThreadId.set(lane.threadId, lane)
    }
  }

  return [...laneByThreadId.entries()].map(([threadId, lane]) => ({
    id: threadId,
    source: "bridgeLane",
    surface: lane.surface ?? "unknown",
    updatedAt: toUnixSeconds({ iso: lane.updatedAt }),
    cwd: lane.repoRoot,
    originator: lane.projectName ?? lane.projectId ?? null,
    title: `${lane.displayName} thread`,
    preview: `lane ${lane.status}`,
  }))
}

const toCountByLabel = ({ labels }: { labels: unknown[] }): CountByLabel[] => {
  const counts = new Map<string, number>()
  for (const label of labels) {
    const normalizedLabel = typeof label === "string" && label.trim().length > 0 ? label : String(label ?? "unknown")
    const current = counts.get(normalizedLabel) ?? 0
    counts.set(normalizedLabel, current + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

const laneStatusIssue = ({ lane }: { lane: DashboardLane }): DashboardIssue | null => {
  if (lane.status === "blocked" || lane.status === "failed" || lane.status === "interrupted") {
    return {
      id: `lane:${lane.laneId}:${lane.status}`,
      source: "lane",
      severity: lane.status === "failed" ? "error" : "warn",
      laneId: lane.laneId,
      type: `lane.status.${lane.status}`,
      message: `${lane.displayName} is ${lane.status}`,
      ts: lane.updatedAt,
    }
  }
  if (lane.status === "needs_approval") {
    return {
      id: `lane:${lane.laneId}:needs_approval`,
      source: "lane",
      severity: "warn",
      laneId: lane.laneId,
      type: "lane.status.needs_approval",
      message: `${lane.displayName} is waiting for approval`,
      ts: lane.updatedAt,
    }
  }
  return null
}

const eventMessage = ({ event }: { event: LaneEvent }): string => {
  if (!event.payload) {
    return event.type
  }
  const payloadMessage = event.payload.message
  if (typeof payloadMessage === "string" && payloadMessage.trim().length > 0) {
    return payloadMessage
  }
  const payloadReason = event.payload.reason
  if (typeof payloadReason === "string" && payloadReason.trim().length > 0) {
    return payloadReason
  }
  return event.type
}

const webhookIssue = ({ webhook }: { webhook: WebhookSubscription }): DashboardIssue | null => {
  if (!webhook.lastError) {
    return null
  }
  return {
    id: `webhook:${webhook.id}:lastError`,
    source: "webhook",
    severity: "error",
    laneId: null,
    type: "webhook.delivery_failed",
    message: webhook.lastError,
    ts: webhook.updatedAt,
  }
}

const requestIssue = ({ requestError }: { requestError: DashboardRequestError }): DashboardIssue => ({
  id: `request:${requestError.endpoint}`,
  source: "request",
  severity: "error",
  laneId: null,
  type: "bridge.request_failed",
  message: `${requestError.endpoint}: ${requestError.message}`,
  ts: new Date().toISOString(),
})

export const buildDashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  const bridgeBaseUrl = resolveBridgeBaseUrl()

  const [
    healthResult,
    watchResult,
    webhooksResult,
    lanesResult,
    laneSessionsResult,
    threadsResult,
    runningResult,
  ] =
    await Promise.all([
      fetchBridgeJson<HealthResponse>({ baseUrl: bridgeBaseUrl, endpoint: "/health" }),
      fetchBridgeJson<WatchStatusResponse>({ baseUrl: bridgeBaseUrl, endpoint: "/watch/status" }),
      fetchBridgeJson<WebhooksResponse>({ baseUrl: bridgeBaseUrl, endpoint: "/webhooks" }),
      fetchBridgeJson<LanesResponse>({ baseUrl: bridgeBaseUrl, endpoint: "/lanes" }),
      fetchBridgeJson<LaneSessionsResponse>({
        baseUrl: bridgeBaseUrl,
        endpoint: "/lanes/sessions",
      }),
      fetchBridgeJson<ThreadsResponse>({
        baseUrl: bridgeBaseUrl,
        endpoint: `/codex/threads?limit=${CODEX_THREADS_LIST_LIMIT}`,
        timeoutMs: BRIDGE_TIMEOUT_MS_CODEX_THREADS,
      }),
      fetchBridgeJson<RunningSessionsResponse>({
        baseUrl: bridgeBaseUrl,
        endpoint: "/codex/running",
        timeoutMs: BRIDGE_TIMEOUT_MS_CODEX_RUNNING,
      }),
    ])

  const rawLanes = lanesResult.ok ? lanesResult.data.lanes : []
  const laneEventsResponses = await Promise.all(
    rawLanes.slice(0, MAX_EVENT_LANE_COUNT).map((lane) =>
      fetchBridgeJson<LaneEventsResponse>({
        baseUrl: bridgeBaseUrl,
        endpoint: `/lanes/${lane.laneId}/events`,
        timeoutMs: BRIDGE_TIMEOUT_MS_EVENTS,
      })
    )
  )

  const laneEvents = laneEventsResponses.flatMap((result) =>
    result.ok ? result.data.events : []
  )
  const requestErrors: DashboardRequestError[] = [
    ...(healthResult.ok ? [] : [healthResult.error]),
    ...(watchResult.ok ? [] : [watchResult.error]),
    ...(webhooksResult.ok ? [] : [webhooksResult.error]),
    ...(lanesResult.ok ? [] : [lanesResult.error]),
    ...(laneSessionsResult.ok ? [] : [laneSessionsResult.error]),
    ...(threadsResult.ok ? [] : [threadsResult.error]),
    ...(runningResult.ok ? [] : [runningResult.error]),
    ...laneEventsResponses.flatMap((result) => (result.ok ? [] : [result.error])),
  ]

  const lanes = rawLanes.map((lane) => enrichLane({ lane }))
  const webhooks = webhooksResult.ok
    ? webhooksResult.data.subscriptions.map((subscription) => ({
        ...subscription,
        scopeKinds:
          subscription.scopeKinds && subscription.scopeKinds.length > 0
            ? subscription.scopeKinds
            : [
                subscription.scope &&
                (subscription.scope.laneIds.length > 0 ||
                  subscription.scope.threadIds.length > 0 ||
                  subscription.scope.sessionIds.length > 0)
                  ? "scoped"
                  : "global",
              ],
      }))
    : []
  const laneSessions = laneSessionsResult.ok ? laneSessionsResult.data.sessions : []
  const fetchedThreads = threadsResult.ok
    ? threadsResult.data.threads.map((thread) => enrichThread({ thread }))
    : []
  const resolvedThreadTree =
    fetchedThreads.length > 0
      ? await resolveThreadAncestors({ baseUrl: bridgeBaseUrl, threads: fetchedThreads })
      : null
  if (resolvedThreadTree?.requestErrors.length) {
    requestErrors.push(...resolvedThreadTree.requestErrors)
  }
  const fallbackThreads = buildFallbackThreadsFromLanes({ lanes }).map((thread) => enrichThread({ thread }))
  const primaryThreads =
    resolvedThreadTree && resolvedThreadTree.threads.length > 0 ? resolvedThreadTree.threads : fetchedThreads
  const threadByIdForSnapshot = new Map(primaryThreads.map((thread) => [thread.id, thread]))
  for (const fallbackThread of fallbackThreads) {
    if (!threadByIdForSnapshot.has(fallbackThread.id)) {
      threadByIdForSnapshot.set(fallbackThread.id, fallbackThread)
    }
  }
  const threads = [...threadByIdForSnapshot.values()]
  const nowSec = Math.floor(Date.now() / 1000)
  const inferredActiveThreadsFromThreads = threads
    .filter((thread) => typeof thread.updatedAt === "number" && nowSec - thread.updatedAt <= 60 * 60)
    .slice(0, 60)
  const activeThreads = inferredActiveThreadsFromThreads
  const laneById = new Map<string, DashboardLane>(lanes.map((lane) => [lane.laneId, lane]))
  const fallbackRunningSessions = buildFallbackRunningSessionsFromLaneSessions({
    laneSessions,
    laneById,
  })
  const threadById = new Map<string, DashboardThread>(
    [...threads, ...activeThreads].map((thread) => [thread.id, thread])
  )
  const runningSessionsSource = runningResult.ok ? runningResult.data.sessions : fallbackRunningSessions
  const runningSessions = runningSessionsSource.map((session) =>
    enrichRunningSession({ session, threadById })
  )
  const runningDetection: DashboardRunningDetection = {
    detectionMode: runningResult.ok
      ? runningResult.data.detectionMode ?? "process"
      : fallbackRunningSessions.length > 0
        ? "lane_sessions"
        : "unknown",
    inferred: runningResult.ok ? runningResult.data.inferred === true : fallbackRunningSessions.length > 0,
    inferredWindowSec:
      runningResult.ok && typeof runningResult.data.inferredWindowSec === "number"
        ? runningResult.data.inferredWindowSec
        : null,
  }

  const eventIssues = laneEvents
    .filter((event) => event.severity === "warn" || event.severity === "error")
    .map((event) => ({
      id: `event:${event.eventId}`,
      source: "event" as const,
      severity: event.severity,
      laneId: event.laneId,
      type: event.type,
      message: eventMessage({ event }),
      ts: event.ts,
    }))

  const laneIssues = lanes
    .map((lane) => laneStatusIssue({ lane }))
    .filter((issue): issue is DashboardIssue => issue !== null)

  const webhookIssues = webhooks
    .map((webhook) => webhookIssue({ webhook }))
    .filter((issue): issue is DashboardIssue => issue !== null)

  const requestIssues = requestErrors.map((requestError) => requestIssue({ requestError }))

  const issues = [...eventIssues, ...laneIssues, ...webhookIssues, ...requestIssues]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, MAX_ISSUE_COUNT)

  const stats: DashboardStats = {
    lanesTotal: lanes.length,
    lanesRunning: lanes.filter((lane) => lane.status === "running").length,
    lanesBlocked: lanes.filter((lane) => lane.status === "blocked").length,
    lanesNeedsApproval: lanes.filter((lane) => lane.status === "needs_approval").length,
    lanesFailed: lanes.filter((lane) => lane.status === "failed").length,
    webhooksTotal: webhooks.length,
    webhooksEnabled: webhooks.filter((webhook) => webhook.enabled).length,
    webhooksWithErrors: webhooks.filter((webhook) => Boolean(webhook.lastError)).length,
    threadsTotal: threads.length,
    activeThreads: activeThreads.length,
    runningSessions: runningSessions.length,
  }

  const distributions: DashboardDistributions = {
    lanesByStatus: toCountByLabel({ labels: lanes.map((lane) => lane.status) }),
    threadsBySource: toCountByLabel({
      labels: threads.map((thread) => thread.sourceGroup),
    }),
    threadsBySurface: toCountByLabel({
      labels: threads.map((thread) => thread.surface ?? "unknown"),
    }),
    activeThreadsBySource: toCountByLabel({
      labels: activeThreads.map((thread) => thread.sourceGroup),
    }),
  }

  const connections: DashboardConnections = {
    bridgeHealthy: healthResult.ok && healthResult.data.ok,
    watcherRunning: watchResult.ok ? watchResult.data.running : false,
    codexThreadEndpointReachable: threadsResult.ok,
    codexRunningEndpointReachable: runningResult.ok,
    hasActiveThreads: activeThreads.length > 0,
    hasRunningCodexSessions: runningSessions.length > 0,
  }

  return {
    generatedAt: new Date().toISOString(),
    bridgeBaseUrl,
    health: healthResult.ok ? healthResult.data : null,
    watch: watchResult.ok ? watchResult.data : null,
    lanes,
    laneSessions,
    webhooks,
    threads,
    activeThreads,
    runningSessions,
    runningDetection,
    laneEvents,
    issues,
    requestErrors,
    topologyDiagnostics: {
      unresolvedParentIds: resolvedThreadTree?.unresolvedParentIds ?? [],
    },
    stats,
    distributions,
    connections,
  }
}
