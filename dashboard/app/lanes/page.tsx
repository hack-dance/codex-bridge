"use client"

import { RefreshCw, Search, Trash2 } from "lucide-react"
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
import {
  laneOwnershipClassName,
  laneStatusClassName,
  formatIso,
  runtimeOriginLabel,
  toDisplayValue,
} from "@/lib/dashboard-ui"
import { runDashboardAction, useDashboardSnapshot } from "@/lib/use-dashboard-snapshot"

const knownLaneStatuses = [
  "all",
  "idle",
  "starting",
  "running",
  "needs_approval",
  "blocked",
  "verifying",
  "done",
  "failed",
  "interrupted",
] as const

type LaneStatusFilter = (typeof knownLaneStatuses)[number]

export default function LanesPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } = useDashboardSnapshot()
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [laneSearch, setLaneSearch] = useState(() => {
    if (typeof window === "undefined") {
      return ""
    }
    return new URLSearchParams(window.location.search).get("search") ?? ""
  })
  const [statusFilter, setStatusFilter] = useState<LaneStatusFilter>("all")
  const [cleanupHours, setCleanupHours] = useState(8)
  const [cleanupArmed, setCleanupArmed] = useState(false)
  const [deleteLaneArmed, setDeleteLaneArmed] = useState<string | null>(null)

  const laneSessionsById = useMemo(
    () => new Map((snapshot?.laneSessions ?? []).map((session) => [session.laneId, session])),
    [snapshot?.laneSessions]
  )
  const threadById = useMemo(
    () => new Map((snapshot?.threads ?? []).map((thread) => [thread.id, thread])),
    [snapshot?.threads]
  )

  const filteredLanes = useMemo(() => {
    const lanes = snapshot?.lanes ?? []
    const lowered = laneSearch.trim().toLowerCase()
    return lanes.filter((lane) => {
      if (statusFilter !== "all" && lane.status !== statusFilter) {
        return false
      }
      if (!lowered) {
        return true
      }
      const haystack = [lane.laneId, lane.threadId, lane.repoRoot, lane.surface]
        .concat([
          lane.displayName,
          threadById.get(lane.threadId ?? "")?.displayName ?? "",
          threadById.get(lane.threadId ?? "")?.originator ?? "",
          threadById.get(lane.threadId ?? "")?.sourceLabel ?? "",
        ])
        .map((part) => part?.toLowerCase() ?? "")
        .join(" ")
      return haystack.includes(lowered)
    })
  }, [snapshot?.lanes, laneSearch, statusFilter, threadById])

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

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Lanes</h1>
          <p className="text-sm text-zinc-400">
            Control lane lifecycle, sessions, and execution ownership for thread-attached work.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton
            label={isRefreshing ? "Refreshing..." : "Refresh"}
            icon={<RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />}
            busy={isRefreshing}
            onClick={() => {
              refreshSnapshot({ isPoll: false }).catch(() => undefined)
            }}
          />
          <input
            type="number"
            min={1}
            max={168}
            value={cleanupHours}
            onChange={(event) => setCleanupHours(Number(event.target.value))}
            className="h-9 w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
          />
          <ActionButton
            label={cleanupArmed ? "Confirm cleanup" : "Cleanup stale"}
            icon={<Trash2 size={14} />}
            busy={pendingActionKey === "lane-cleanup"}
            onClick={() => {
              if (!cleanupArmed) {
                setCleanupArmed(true)
                return
              }
              setCleanupArmed(false)
              runAction({
                actionKey: "lane-cleanup",
                successMessage: "Lane cleanup completed",
                payload: {
                  action: "lane-cleanup",
                  statuses: ["blocked", "done", "failed", "interrupted"],
                  olderThanHours: cleanupHours,
                  syntheticOnly: false,
                  limit: 250,
                },
              }).catch(() => undefined)
            }}
          />
        </div>
      </header>

      {error ? <Banner tone="error" text={error} /> : null}
      {actionError ? <Banner tone="error" text={actionError} /> : null}
      {actionMessage ? <Banner tone="success" text={actionMessage} /> : null}
      {cleanupArmed ? (
        <p className="text-xs text-amber-300">
          Cleanup is armed. Click &ldquo;Confirm cleanup&rdquo; to delete stale terminal lanes older than{" "}
          {cleanupHours}h.
        </p>
      ) : null}

      <LaneModelPrimer />

      <Panel title={`All Lanes (${filteredLanes.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <label className="flex h-9 min-w-[320px] items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100">
            <Search size={14} className="text-zinc-500" />
            <input
              type="search"
              value={laneSearch}
              onChange={(event) => setLaneSearch(event.target.value)}
              placeholder="Search lane, thread, path, surface..."
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as LaneStatusFilter)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
          >
            {knownLaneStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        {isLoading && !snapshot ? (
          <p className="text-sm text-zinc-400">Loading lanes...</p>
        ) : filteredLanes.length === 0 ? (
          <EmptyState text="No lanes match the active filters." />
        ) : (
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-zinc-800">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Lane</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Thread</th>
                  <th className="px-3 py-2">Ownership</th>
                  <th className="px-3 py-2">Session</th>
                  <th className="px-3 py-2">Origin / Surface</th>
                  <th className="px-3 py-2">Repo</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredLanes.map((lane) => {
                  const session = laneSessionsById.get(lane.laneId)
                  const linkedThread = lane.threadId ? threadById.get(lane.threadId) : null
                  return (
                    <tr key={lane.laneId} className="align-top hover:bg-zinc-900/60">
                      <td className="px-3 py-2">
                        <Link
                          href={`/topology?search=${encodeURIComponent(lane.laneId)}`}
                          className="block text-xs text-zinc-200 hover:text-zinc-50"
                        >
                          {lane.displayName}
                        </Link>
                        <p className="mono mt-1 text-[11px] text-zinc-500">{lane.laneId}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${laneStatusClassName({ status: lane.status })}`}
                        >
                          {lane.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-300">
                        {lane.threadId ? (
                          <Link
                            href={`/threads?search=${encodeURIComponent(lane.threadId)}`}
                            className="block text-xs text-zinc-200 hover:text-zinc-50"
                          >
                            {threadById.get(lane.threadId)?.displayName ?? lane.threadId}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {lane.threadId ? (
                          <p className="mono mt-1 text-[11px] text-zinc-500">{lane.threadId}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${laneOwnershipClassName({
                            ownershipType: lane.ownershipType,
                          })}`}
                        >
                          {lane.ownershipLabel}
                        </span>
                        {lane.ownerRef ? (
                          <p className="mono mt-1 text-[11px] text-zinc-500">{lane.ownerRef}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-semibold ${
                            session?.running ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-700"
                          }`}
                        >
                          {session?.running ? "running" : "stopped"}
                        </span>
                        <div className="mt-1 text-xs text-zinc-400">
                          pending {session?.pendingRequests ?? 0}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <p className="text-xs text-zinc-300">
                          {runtimeOriginLabel({
                            originator: linkedThread?.originator,
                            sourceLabel: linkedThread?.sourceLabel,
                            surface: lane.surface,
                          })}
                        </p>
                        <p className="mono mt-1 text-[11px] text-zinc-500">
                          surface {toDisplayValue({ value: lane.surface })}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">
                        <p>{lane.projectName ?? "unknown"}</p>
                        <p className="mono mt-1 text-[11px] text-zinc-500">
                          {toDisplayValue({ value: lane.repoRoot })}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{formatIso({ value: lane.updatedAt })}</td>
                      <td className="px-3 py-2">
                        <RowActionMenu label={`Actions for lane ${lane.displayName}`}>
                          <RowActionMenuButton
                            label="Sync lane"
                            busy={pendingActionKey === `lane-sync:${lane.laneId}`}
                            onClick={() => {
                              runAction({
                                actionKey: `lane-sync:${lane.laneId}`,
                                successMessage: `Lane ${lane.laneId} synced`,
                                payload: { action: "lane-sync", laneId: lane.laneId },
                              }).catch(() => undefined)
                            }}
                          />
                          {session?.running ? (
                            <RowActionMenuButton
                              label="Stop session"
                              busy={pendingActionKey === `lane-stop-session:${lane.laneId}`}
                              onClick={() => {
                                runAction({
                                  actionKey: `lane-stop-session:${lane.laneId}`,
                                  successMessage: `Lane ${lane.laneId} session stopped`,
                                  payload: { action: "lane-stop-session", laneId: lane.laneId },
                                }).catch(() => undefined)
                              }}
                            />
                          ) : (
                            <RowActionMenuButton
                              label="Start session"
                              busy={pendingActionKey === `lane-start-session:${lane.laneId}`}
                              onClick={() => {
                                runAction({
                                  actionKey: `lane-start-session:${lane.laneId}`,
                                  successMessage: `Lane ${lane.laneId} session started`,
                                  payload: { action: "lane-start-session", laneId: lane.laneId },
                                }).catch(() => undefined)
                              }}
                            />
                          )}
                          <RowActionMenuLink
                            href={`/webhooks?laneId=${encodeURIComponent(lane.laneId)}`}
                            label="Add webhook subscription"
                          />
                          <RowActionMenuButton
                            label={deleteLaneArmed === lane.laneId ? "Confirm delete lane" : "Delete lane"}
                            variant="danger"
                            busy={pendingActionKey === `lane-delete:${lane.laneId}`}
                            onClick={() => {
                              if (deleteLaneArmed !== lane.laneId) {
                                setDeleteLaneArmed(lane.laneId)
                                return
                              }
                              setDeleteLaneArmed(null)
                              runAction({
                                actionKey: `lane-delete:${lane.laneId}`,
                                successMessage: `Lane ${lane.laneId} deleted`,
                                payload: { action: "lane-delete", laneId: lane.laneId },
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
