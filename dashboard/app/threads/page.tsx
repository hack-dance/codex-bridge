"use client"

import { RefreshCw, Search } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

import {
  ActionButton,
  Banner,
  EmptyState,
  Panel,
  RowActionMenu,
  RowActionMenuButton,
  RowActionMenuLink,
} from "@/components/hud-primitives"
import { LaneModelPrimer } from "@/components/lane-model-primer"
import { formatIso, runtimeOriginLabel, toDisplayValue } from "@/lib/dashboard-ui"
import type { DashboardThread } from "@/lib/dashboard-data"
import { runDashboardAction, useDashboardSnapshot } from "@/lib/use-dashboard-snapshot"

interface ThreadTreeNode {
  thread: DashboardThread
  depth: number
}

const clampDepth = ({ depth }: { depth: number | null }) => {
  if (typeof depth !== "number" || Number.isNaN(depth)) {
    return 0
  }
  return Math.max(0, Math.min(depth, 12))
}

const buildThreadTree = ({
  threads,
}: {
  threads: DashboardThread[]
}): ThreadTreeNode[] => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const childrenByParent = new Map<string, DashboardThread[]>()
  const roots: DashboardThread[] = []

  for (const thread of threads) {
    const parentId = thread.sourceParentThreadId
    if (parentId && byId.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? []
      list.push(thread)
      childrenByParent.set(parentId, list)
      continue
    }
    roots.push(thread)
  }

  const sortThreads = (left: DashboardThread, right: DashboardThread) =>
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0)

  roots.sort(sortThreads)
  for (const list of childrenByParent.values()) {
    list.sort(sortThreads)
  }

  const out: ThreadTreeNode[] = []
  const seen = new Set<string>()

  const walk = ({ node, depth }: { node: DashboardThread; depth: number }) => {
    if (seen.has(node.id)) {
      return
    }
    seen.add(node.id)
    out.push({ thread: node, depth })
    const children = childrenByParent.get(node.id) ?? []
    for (const child of children) {
      walk({ node: child, depth: depth + 1 })
    }
  }

  for (const root of roots) {
    walk({ node: root, depth: 0 })
  }
  return out
}

export default function ThreadsPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } = useDashboardSnapshot()
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [archiveArmedThreadId, setArchiveArmedThreadId] = useState<string | null>(null)
  const [liveOnly, setLiveOnly] = useState(false)
  const [search, setSearch] = useState(() => {
    if (typeof window === "undefined") {
      return ""
    }
    return new URLSearchParams(window.location.search).get("search") ?? ""
  })

  const laneIdsByThreadId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const lane of snapshot?.lanes ?? []) {
      if (!lane.threadId) {
        continue
      }
      const list = map.get(lane.threadId) ?? []
      list.push(lane.laneId)
      map.set(lane.threadId, list)
    }
    return map
  }, [snapshot?.lanes])

  const runningSessionThreadIds = useMemo(() => {
    const threadIds = new Set<string>()
    for (const session of snapshot?.runningSessions ?? []) {
      if (session.threadId) {
        threadIds.add(session.threadId)
      }
    }
    for (const laneSession of snapshot?.laneSessions ?? []) {
      if (laneSession.running && laneSession.threadId) {
        threadIds.add(laneSession.threadId)
      }
    }
    return threadIds
  }, [snapshot?.laneSessions, snapshot?.runningSessions])

  const activeThreadIds = useMemo(
    () => new Set((snapshot?.activeThreads ?? []).map((thread) => thread.id)),
    [snapshot?.activeThreads]
  )
  const liveThreadIds = useMemo(() => {
    const threadIds = new Set<string>((snapshot?.activeThreads ?? []).map((thread) => thread.id))
    for (const session of snapshot?.runningSessions ?? []) {
      if (session.threadId) {
        threadIds.add(session.threadId)
      }
    }
    for (const laneSession of snapshot?.laneSessions ?? []) {
      if (
        (laneSession.running || laneSession.pendingRequests > 0 || laneSession.readinessDeferred) &&
        laneSession.threadId
      ) {
        threadIds.add(laneSession.threadId)
      }
    }
    return threadIds
  }, [snapshot?.activeThreads, snapshot?.laneSessions, snapshot?.runningSessions])
  const threadById = useMemo(
    () => new Map((snapshot?.threads ?? []).map((thread) => [thread.id, thread])),
    [snapshot?.threads]
  )

  const runAction = async ({
    payload,
    actionKey,
    successMessage,
  }: {
    payload: Record<string, unknown>
    actionKey: string
    successMessage: string
  }) => {
    setPendingActionKey(actionKey)
    setActionError(null)
    setActionMessage(null)
    try {
      await runDashboardAction({ payload })
      setActionMessage(successMessage)
      await refreshSnapshot({ isPoll: false })
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Action failed"
      setActionError(message)
    } finally {
      setPendingActionKey(null)
    }
  }

  const treeRows = useMemo(() => {
    const rows = buildThreadTree({ threads: snapshot?.threads ?? [] })
    const rowsWithLiveFilter = liveOnly ? rows.filter(({ thread }) => liveThreadIds.has(thread.id)) : rows
    const lowered = search.trim().toLowerCase()
    if (!lowered) {
      return rowsWithLiveFilter
    }
    return rowsWithLiveFilter.filter(({ thread }) => {
      const haystack = [
        thread.id,
        thread.title,
        thread.cwd,
        thread.sourceLabel,
        thread.sourceDetail,
        thread.sourceParentThreadId,
        thread.displayName,
        thread.projectName,
      ]
        .map((value) => value?.toLowerCase() ?? "")
        .join(" ")
      return haystack.includes(lowered)
    })
  }, [snapshot?.threads, search, liveOnly, liveThreadIds])

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Threads</h1>
          <p className="text-sm text-zinc-400">
            Hierarchical thread graph with lane attachments, sub-agent lineage, and archive controls.
          </p>
        </div>
        <ActionButton
          label={isRefreshing ? "Refreshing..." : "Refresh"}
          icon={<RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />}
          busy={isRefreshing}
          onClick={() => {
            refreshSnapshot({ isPoll: false }).catch(() => undefined)
          }}
        />
      </header>

      {error ? <Banner tone="error" text={error} /> : null}
      {actionError ? <Banner tone="error" text={actionError} /> : null}
      {actionMessage ? <Banner tone="success" text={actionMessage} /> : null}

      <LaneModelPrimer title="Entity ownership model" compact showStatusLegend={false} />

      <Panel title={`Thread Topology (${treeRows.length})`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="flex h-9 min-w-[340px] items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100">
            <Search size={14} className="text-zinc-500" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search thread id, title, source, cwd..."
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
            />
          </label>
          <label className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={liveOnly}
              onChange={(event) => setLiveOnly(event.target.checked)}
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
            />
            live only
          </label>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
            live threads {liveThreadIds.size}
          </span>
        </div>

        {isLoading && !snapshot ? (
          <p className="text-sm text-zinc-400">Loading threads...</p>
        ) : treeRows.length === 0 ? (
          <EmptyState text="No threads match the active filter." />
        ) : (
          <div className="max-h-[72vh] overflow-auto rounded-lg border border-zinc-800">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Thread</th>
                  <th className="px-3 py-2">Origin / Source</th>
                  <th className="px-3 py-2">Parent</th>
                  <th className="px-3 py-2">Lanes</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Project</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {treeRows.map(({ thread, depth }) => {
                  const attachedLanes = laneIdsByThreadId.get(thread.id) ?? []
                  const hasRunningSession = runningSessionThreadIds.has(thread.id)
                  const isActive = activeThreadIds.has(thread.id)
                  const isLive = liveThreadIds.has(thread.id)
                  return (
                    <tr key={thread.id} className="align-top hover:bg-zinc-900/60">
                      <td className="px-3 py-2">
                        <div
                          className="flex items-start gap-2"
                          style={{ paddingLeft: `${clampDepth({ depth }) * 14}px` }}
                        >
                          {depth > 0 ? (
                            <span className="mt-1 text-[10px] text-zinc-500">└─</span>
                          ) : null}
                          <div>
                            <Link
                              href={`/topology?search=${encodeURIComponent(thread.id)}`}
                              className="block text-xs text-zinc-200 hover:text-zinc-50"
                            >
                              {thread.displayName}
                            </Link>
                            <p className="mono mt-1 text-[11px] text-zinc-500">{thread.id}</p>
                            <p className="text-xs text-zinc-400">{toDisplayValue({ value: thread.title })}</p>
                            {thread.sourceAgentNickname ? (
                              <p className="text-[11px] text-indigo-300">
                                sub-agent {thread.sourceAgentNickname}
                                {thread.sourceAgentRole ? ` (${thread.sourceAgentRole})` : ""}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <p className="text-xs text-zinc-200">
                          {runtimeOriginLabel({
                            originator: thread.originator,
                            sourceLabel: thread.sourceLabel,
                            surface: thread.surface,
                          })}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {thread.sourceLabel}
                          {thread.sourceDetail ? ` · ${thread.sourceDetail}` : ""}
                        </p>
                      </td>
                      <td className="px-3 py-2 mono text-xs text-zinc-400">
                        {thread.sourceParentThreadId ? (
                          <div>
                            <Link
                              href={`/threads?search=${encodeURIComponent(thread.sourceParentThreadId)}`}
                              className="block text-xs text-zinc-300 hover:text-zinc-100"
                            >
                              {threadById.get(thread.sourceParentThreadId)?.displayName ??
                                thread.sourceParentThreadId}
                            </Link>
                            <p className="mono mt-1 text-[11px] text-zinc-500">
                              {thread.sourceParentThreadId}
                            </p>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {attachedLanes.length === 0 ? (
                          <span className="text-xs text-zinc-500">none</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {attachedLanes.slice(0, 4).map((laneId) => (
                              <Link
                                key={laneId}
                                href={`/lanes?search=${encodeURIComponent(laneId)}`}
                                className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                              >
                                {laneId}
                              </Link>
                            ))}
                            {attachedLanes.length > 4 ? (
                              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                                +{attachedLanes.length - 4}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1 text-xs">
                          <span
                            className={`rounded px-2 py-0.5 font-medium ${
                              isLive
                                ? "animate-pulse bg-cyan-100 text-cyan-900"
                                : "bg-zinc-200 text-zinc-700"
                            }`}
                          >
                            {isLive ? "LIVE" : "quiet"}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 font-medium ${
                              isActive ? "bg-blue-100 text-blue-800" : "bg-zinc-200 text-zinc-700"
                            }`}
                          >
                            {isActive ? "active" : "idle"}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 font-medium ${
                              hasRunningSession
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-zinc-200 text-zinc-700"
                            }`}
                          >
                            {hasRunningSession ? "session running" : "session stopped"}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">{toDisplayValue({ value: thread.cwd })}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{thread.projectName ?? "unknown"}</td>
                      <td className="px-3 py-2 text-xs text-zinc-400">
                        {formatIso({
                          value:
                            typeof thread.updatedAt === "number"
                              ? new Date(thread.updatedAt * 1000).toISOString()
                              : null,
                        })}
                      </td>
                      <td className="px-3 py-2">
                        <RowActionMenu label={`Actions for thread ${thread.displayName}`}>
                          <RowActionMenuLink
                            href={`/webhooks?threadId=${encodeURIComponent(thread.id)}`}
                            label="Add webhook subscription"
                          />
                          <RowActionMenuButton
                            label={archiveArmedThreadId === thread.id ? "Confirm archive thread" : "Archive thread"}
                            variant="danger"
                            busy={pendingActionKey === `thread-archive:${thread.id}`}
                            onClick={() => {
                              if (archiveArmedThreadId !== thread.id) {
                                setArchiveArmedThreadId(thread.id)
                                return
                              }
                              setArchiveArmedThreadId(null)
                              runAction({
                                actionKey: `thread-archive:${thread.id}`,
                                successMessage: `Thread ${thread.displayName} archived`,
                                payload: { action: "thread-archive", threadId: thread.id },
                              }).catch(() => undefined)
                            }}
                          />
                        </RowActionMenu>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
