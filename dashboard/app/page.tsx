"use client"

import {
  Activity,
  BellRing,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Waves,
  Zap,
} from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

import {
  ActionButton,
  Banner,
  ConnectionBadge,
  EmptyState,
  Panel,
  RowActionMenu,
  RowActionMenuLink,
  StatCard,
} from "@/components/hud-primitives"
import { LaneModelPrimer } from "@/components/lane-model-primer"
import type { DashboardIssue } from "@/lib/dashboard-data"
import {
  formatIso,
  laneOwnershipClassName,
  runtimeOriginLabel,
  toDisplayValue,
  webhookHealth,
  webhookHealthClassName,
} from "@/lib/dashboard-ui"
import { runDashboardAction, useDashboardSnapshot } from "@/lib/use-dashboard-snapshot"

const issueClassName = ({ severity }: { severity: DashboardIssue["severity"] }): string => {
  if (severity === "error") {
    return "bg-rose-100 text-rose-800"
  }
  if (severity === "warn") {
    return "bg-amber-100 text-amber-800"
  }
  return "bg-zinc-100 text-zinc-700"
}

export default function HomePage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } = useDashboardSnapshot()
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)

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

  const lanes = useMemo(
    () =>
      snapshot?.lanes
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10) ?? [],
    [snapshot?.lanes]
  )
  const topIssues = useMemo(() => snapshot?.issues.slice(0, 8) ?? [], [snapshot?.issues])
  const activeThreads = useMemo(() => snapshot?.activeThreads.slice(0, 10) ?? [], [snapshot?.activeThreads])
  const webhookItems = useMemo(() => snapshot?.webhooks.slice(0, 10) ?? [], [snapshot?.webhooks])
  const threadById = useMemo(
    () => new Map((snapshot?.threads ?? []).map((thread) => [thread.id, thread])),
    [snapshot?.threads]
  )
  const laneById = useMemo(
    () => new Map((snapshot?.lanes ?? []).map((lane) => [lane.laneId, lane])),
    [snapshot?.lanes]
  )
  const liveThreadsNow = useMemo(() => {
    const threadIds = new Set<string>((snapshot?.activeThreads ?? []).map((thread) => thread.id))
    for (const laneSession of snapshot?.laneSessions ?? []) {
      if (
        laneSession.running ||
        laneSession.pendingRequests > 0 ||
        laneSession.readinessDeferred
      ) {
        if (laneSession.threadId) {
          threadIds.add(laneSession.threadId)
          continue
        }
        const linkedLane = laneById.get(laneSession.laneId)
        if (linkedLane?.threadId) {
          threadIds.add(linkedLane.threadId)
        }
      }
    }
    const nowMs = Date.now()
    for (const laneEvent of snapshot?.laneEvents ?? []) {
      if (!laneEvent.type.startsWith("lane.turn.")) {
        continue
      }
      const eventMs = Date.parse(laneEvent.ts)
      if (Number.isNaN(eventMs) || nowMs - eventMs > 20_000) {
        continue
      }
      const linkedLane = laneById.get(laneEvent.laneId)
      if (linkedLane?.threadId) {
        threadIds.add(linkedLane.threadId)
      }
    }
    return [...threadIds]
      .map((threadId) => threadById.get(threadId))
      .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 14)
  }, [laneById, snapshot?.activeThreads, snapshot?.laneEvents, snapshot?.laneSessions, threadById])
  const liveSessionCount = useMemo(
    () =>
      (snapshot?.laneSessions ?? []).filter(
        (laneSession) =>
          laneSession.running ||
          laneSession.pendingRequests > 0 ||
          laneSession.readinessDeferred
      ).length,
    [snapshot?.laneSessions]
  )

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-lg shadow-black/20 backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mono text-xs uppercase tracking-[0.2em] text-zinc-500">Overview</p>
            <h1 className="mt-1 text-3xl font-semibold">Codex Bridge Operations</h1>
            <p className="mt-2 max-w-3xl text-sm text-zinc-400">
              Live view of lanes, thread activity, webhook coverage, and runtime health.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              label={isRefreshing ? "Refreshing..." : "Refresh"}
              icon={isRefreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              busy={isRefreshing}
              onClick={() => {
                refreshSnapshot({ isPoll: false }).catch(() => undefined)
              }}
            />
            <ActionButton
              label="Reconcile stale"
              icon={<Sparkles size={14} />}
              busy={pendingActionKey === "reconcile-stale"}
              onClick={() => {
                runAction({
                  actionKey: "reconcile-stale",
                  successMessage: "Reconciled stale lanes",
                  payload: { action: "reconcile-stale" },
                }).catch(() => undefined)
              }}
            />
            <ActionButton
              label={snapshot?.watch?.running ? "Stop watcher" : "Start watcher"}
              icon={<Waves size={14} />}
              busy={pendingActionKey === "watch-toggle"}
              onClick={() => {
                runAction({
                  actionKey: "watch-toggle",
                  successMessage: snapshot?.watch?.running ? "Watcher stopped" : "Watcher started",
                  payload: {
                    action: snapshot?.watch?.running ? "watch-stop" : "watch-start",
                  },
                }).catch(() => undefined)
              }}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <ConnectionBadge label="Bridge" value={snapshot?.connections.bridgeHealthy === true} />
          <ConnectionBadge label="Watcher" value={snapshot?.connections.watcherRunning === true} />
          <ConnectionBadge
            label="Threads endpoint"
            value={snapshot?.connections.codexThreadEndpointReachable === true}
          />
          <ConnectionBadge
            label="Running endpoint"
            value={snapshot?.connections.codexRunningEndpointReachable === true}
          />
          <ConnectionBadge label="Active threads" value={snapshot?.connections.hasActiveThreads === true} />
          <ConnectionBadge
            label="Running sessions"
            value={snapshot?.connections.hasRunningCodexSessions === true}
          />
        </div>
      </header>

      {error ? <Banner tone="error" text={error} /> : null}
      {actionError ? <Banner tone="error" text={actionError} /> : null}
      {actionMessage ? <Banner tone="success" text={actionMessage} /> : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <StatCard title="Lanes" value={snapshot?.stats.lanesTotal ?? 0} subtitle="All managed lanes" />
        <StatCard title="Running" value={snapshot?.stats.lanesRunning ?? 0} subtitle="Lane status: running" />
        <StatCard
          title="Needs Approval"
          value={snapshot?.stats.lanesNeedsApproval ?? 0}
          subtitle="Blocked by approval"
        />
        <StatCard title="Webhooks" value={snapshot?.stats.webhooksTotal ?? 0} subtitle="Subscriptions total" />
        <StatCard title="Threads" value={snapshot?.stats.threadsTotal ?? 0} subtitle="Threads indexed" />
        <StatCard
          title="Sessions"
          value={snapshot?.stats.runningSessions ?? 0}
          subtitle={snapshot?.runningDetection.inferred ? "Inferred mode" : "Process mode"}
        />
      </section>

      <LaneModelPrimer compact={false} />

      <Panel
        title="Live Runtime Now"
        description="Threads with active generation/execution signals (running session, pending requests, or very recent turn events)."
        actions={
          <Link href="/topology" className="text-xs text-zinc-400 hover:text-zinc-200">
            open topology →
          </Link>
        }
      >
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span className="rounded border border-cyan-700/50 bg-cyan-950/25 px-2 py-1 text-cyan-100">
            live threads {liveThreadsNow.length}
          </span>
          <span className="rounded border border-cyan-700/50 bg-cyan-950/25 px-2 py-1 text-cyan-100">
            live sessions {liveSessionCount}
          </span>
        </div>
        {liveThreadsNow.length === 0 ? (
          <EmptyState text="No currently live thread activity detected in this snapshot." />
        ) : (
          <div className="flex flex-wrap gap-2">
            {liveThreadsNow.map((thread) => (
              <Link
                key={thread.id}
                href={`/threads?search=${encodeURIComponent(thread.id)}`}
                className="rounded-md border border-cyan-700/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-950/35"
              >
                <p className="font-medium">{thread.displayName}</p>
                <p className="mono mt-1 text-[11px] text-cyan-200/80">{thread.shortId}</p>
                <p className="mt-1 text-[11px] text-cyan-100/80">{thread.projectName ?? "Unassigned"}</p>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      <section className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Lane Activity"
          description="Lanes are execution rails attached to threads; session runtime is managed per lane."
          actions={
            <Link href="/lanes" className="text-xs text-zinc-400 hover:text-zinc-200">
              open lanes →
            </Link>
          }
        >
          {isLoading && !snapshot ? (
            <p className="text-sm text-zinc-400">Loading lanes...</p>
          ) : lanes.length === 0 ? (
            <EmptyState text="No lanes found." />
          ) : (
            <div className="max-h-[360px] overflow-auto rounded-lg border border-zinc-800">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Lane</th>
                    <th className="px-3 py-2">Thread</th>
                    <th className="px-3 py-2">Ownership</th>
                    <th className="px-3 py-2">Project</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Updated</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {lanes.map((lane) => (
                    <tr key={lane.laneId} className="hover:bg-zinc-900/60">
                      <td className="px-3 py-2">
                        <Link
                          href={`/lanes?search=${encodeURIComponent(lane.laneId)}`}
                          className="block text-xs text-zinc-200 hover:text-zinc-50"
                        >
                          {lane.displayName}
                        </Link>
                        <p className="mono mt-1 text-[11px] text-zinc-500">{lane.laneId}</p>
                      </td>
                      <td className="px-3 py-2">
                        {lane.threadId ? (
                          <div>
                            <Link
                              href={`/threads?search=${encodeURIComponent(lane.threadId)}`}
                              className="text-xs text-zinc-300 hover:text-zinc-100"
                            >
                              {threadById.get(lane.threadId)?.displayName ?? lane.threadId}
                            </Link>
                            <p className="mono mt-1 text-[11px] text-zinc-500">{lane.threadId}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${laneOwnershipClassName({
                            ownershipType: lane.ownershipType,
                          })}`}
                        >
                          {lane.ownershipLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{lane.projectName ?? "unknown"}</td>
                      <td className="px-3 py-2 text-xs text-zinc-300">{lane.status}</td>
                      <td className="px-3 py-2 text-xs text-zinc-500">{formatIso({ value: lane.updatedAt })}</td>
                      <td className="px-3 py-2">
                        <RowActionMenu label={`Actions for lane ${lane.displayName}`}>
                          <RowActionMenuLink
                            href={`/lanes?search=${encodeURIComponent(lane.laneId)}`}
                            label="Open lane controls"
                          />
                          <RowActionMenuLink
                            href={`/webhooks?laneId=${encodeURIComponent(lane.laneId)}`}
                            label="Add webhook subscription"
                          />
                        </RowActionMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Thread + Session Signal"
          description="Active thread feed and running session detection state."
          actions={
            <Link href="/threads" className="text-xs text-zinc-400 hover:text-zinc-200">
              open threads →
            </Link>
          }
        >
          <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
            <SquareTerminal size={12} />
            detection mode: {snapshot?.runningDetection.detectionMode ?? "unknown"}
            {snapshot?.runningDetection.inferred ? " (inferred)" : ""}
          </div>
          {activeThreads.length === 0 ? (
            <EmptyState text="No active threads in the current snapshot." />
          ) : (
            <div className="max-h-[360px] overflow-auto rounded-lg border border-zinc-800">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Thread</th>
                    <th className="px-3 py-2">Origin / Source</th>
                    <th className="px-3 py-2">Project</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {activeThreads.map((thread) => (
                    <tr key={thread.id} className="hover:bg-zinc-900/60">
                      <td className="px-3 py-2">
                        <Link
                          href={`/threads?search=${encodeURIComponent(thread.id)}`}
                          className="block text-xs text-zinc-200 hover:text-zinc-50"
                        >
                          {thread.displayName}
                        </Link>
                        <p className="mono mt-1 text-[11px] text-zinc-500">{thread.id}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-300">
                        <p>
                          {runtimeOriginLabel({
                            originator: thread.originator,
                            sourceLabel: thread.sourceLabel,
                            surface: thread.surface,
                          })}
                        </p>
                        <p className="mt-1 text-zinc-500">
                          {thread.sourceLabel}
                          {thread.sourceDetail ? ` · ${thread.sourceDetail}` : ""}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{thread.projectName ?? "unknown"}</td>
                      <td className="max-w-[280px] truncate px-3 py-2 mono text-xs text-zinc-500">
                        {toDisplayValue({ value: thread.cwd })}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">
                        {formatIso({
                          value:
                            typeof thread.updatedAt === "number"
                              ? new Date(thread.updatedAt * 1000).toISOString()
                              : null,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Webhook Health"
          description="Top subscriptions with scope and delivery status."
          actions={
            <div className="flex items-center gap-2">
              <Link href="/webhooks" className="text-xs text-zinc-400 hover:text-zinc-200">
                open webhooks →
              </Link>
              <Link href="/webhooks?create=1" className="text-xs text-zinc-400 hover:text-zinc-200">
                create →
              </Link>
            </div>
          }
        >
          {webhookItems.length === 0 ? (
            <EmptyState text="No webhook subscriptions configured." />
          ) : (
            <div className="space-y-2">
              {webhookItems.map((hook) => {
                const health = webhookHealth({
                  enabled: hook.enabled,
                  lastDeliveryAt: hook.lastDeliveryAt,
                  lastError: hook.lastError,
                })
                return (
                  <article
                    key={hook.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="mono text-xs text-zinc-200">{hook.id}</p>
                        <p className="text-xs text-zinc-500">{hook.url}</p>
                      </div>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${webhookHealthClassName({
                          health,
                        })}`}
                      >
                        {health}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {(hook.scopeKinds && hook.scopeKinds.length > 0 ? hook.scopeKinds : ["global"]).map(
                        (kind) => (
                          <span
                            key={`${hook.id}:${kind}`}
                            className="rounded bg-indigo-950/60 px-2 py-0.5 text-[11px] text-indigo-200"
                          >
                            {kind}
                          </span>
                        )
                      )}
                      {hook.events.slice(0, 4).map((eventType) => (
                        <span
                          key={`${hook.id}:${eventType}`}
                          className="rounded bg-zinc-800 px-2 py-0.5 mono text-[11px] text-zinc-300"
                        >
                          {eventType}
                        </span>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </Panel>

        <Panel
          title="Issues"
          description="Most recent warning/error signals from lanes, webhooks, and bridge requests."
          actions={
            <Link href="/system" className="text-xs text-zinc-400 hover:text-zinc-200">
              open system →
            </Link>
          }
        >
          {topIssues.length === 0 ? (
            <EmptyState text="No warnings or errors surfaced in this snapshot." />
          ) : (
            <div className="space-y-2">
              {topIssues.map((issue) => (
                <article
                  key={issue.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-sm"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${issueClassName({ severity: issue.severity })}`}>
                      {issue.severity}
                    </span>
                    <span className="text-xs text-zinc-400">{issue.source}</span>
                    <span className="text-xs text-zinc-500">{issue.type}</span>
                    {issue.source === "webhook" ? <BellRing size={12} className="text-zinc-500" /> : null}
                    {issue.source === "request" ? <ShieldAlert size={12} className="text-zinc-500" /> : null}
                    {issue.source === "lane" ? <Activity size={12} className="text-zinc-500" /> : null}
                    {issue.source === "event" ? <Zap size={12} className="text-zinc-500" /> : null}
                  </div>
                  <p className="text-zinc-200">{issue.message}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {formatIso({ value: issue.ts })}
                    {issue.laneId ? ` · lane ${issue.laneId}` : ""}
                  </p>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </section>
    </div>
  )
}
