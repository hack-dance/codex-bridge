"use client"

import { BookOpen, RefreshCw } from "lucide-react"
import Link from "next/link"

import { ActionButton, Banner, EmptyState, Panel } from "@/components/hud-primitives"
import { formatIso } from "@/lib/dashboard-ui"
import { useDashboardSnapshot } from "@/lib/use-dashboard-snapshot"

const formatWindow = ({ seconds }: { seconds: number | null | undefined }): string => {
  if (typeof seconds !== "number" || seconds <= 0) {
    return "n/a"
  }
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

export default function SystemPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } = useDashboardSnapshot()

  const health = snapshot?.health
  const runningDetection = snapshot?.runningDetection

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">System</h1>
          <p className="text-sm text-zinc-400">
            Bridge runtime health, app-server connectivity, and codex binary/runtime configuration.
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

      {isLoading && !snapshot ? (
        <p className="text-sm text-zinc-400">Loading system details...</p>
      ) : !snapshot ? (
        <EmptyState text="System details unavailable." />
      ) : (
        <>
          <Panel title="Runtime Status">
            <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Bridge health</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {snapshot.connections.bridgeHealthy ? "healthy" : "degraded"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">App-server status</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {snapshot.connections.codexThreadEndpointReachable ? "reachable" : "unreachable"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Running detection mode</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {(runningDetection?.detectionMode ?? "unknown").replace("_", " ")}
                  {runningDetection?.inferred ? " (inferred from thread activity)" : ""}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Inferred window</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {formatWindow({ seconds: runningDetection?.inferredWindowSec })}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Watcher</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {snapshot.connections.watcherRunning ? "running" : "stopped"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Snapshot generated</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {formatIso({ value: snapshot.generatedAt })}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Codex Runtime">
            <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Bridge version</dt>
                <dd className="mt-1 font-medium text-zinc-100">{health?.version ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Codex app-server version</dt>
                <dd className="mt-1 font-medium text-zinc-100">
                  {health?.codexAppServerVersion ?? "unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Codex binary</dt>
                <dd className="mt-1 break-all font-mono text-xs text-zinc-200">
                  {health?.codexBin ?? "unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">App-server transport</dt>
                <dd className="mt-1 break-all font-mono text-xs text-zinc-200">
                  {health?.codexAppServerWsUrl ?? "stdio"}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel
            title="API Surface Coverage"
            description="Current dashboard controls mapped to key bridge API capabilities."
          >
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <article className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <p className="mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">lanes</p>
                <p className="mt-1 text-zinc-200">
                  Sync lane, start/stop lane session, delete lane, and bulk stale cleanup.
                </p>
                <Link href="/lanes" className="mt-2 inline-block text-xs text-zinc-400 hover:text-zinc-200">
                  manage lanes →
                </Link>
              </article>
              <article className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <p className="mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">threads</p>
                <p className="mt-1 text-zinc-200">
                  Hierarchy view, lane associations, and archive thread action.
                </p>
                <Link href="/threads" className="mt-2 inline-block text-xs text-zinc-400 hover:text-zinc-200">
                  manage threads →
                </Link>
              </article>
              <article className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <p className="mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">webhooks</p>
                <p className="mt-1 text-zinc-200">
                  Create global/scoped subscriptions and test/enable/disable/delete existing webhooks.
                </p>
                <Link href="/webhooks" className="mt-2 inline-block text-xs text-zinc-400 hover:text-zinc-200">
                  manage webhooks →
                </Link>
              </article>
              <article className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <p className="mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">runtime</p>
                <p className="mt-1 text-zinc-200">
                  Reconcile stale state and start/stop watcher from overview controls.
                </p>
                <Link href="/" className="mt-2 inline-block text-xs text-zinc-400 hover:text-zinc-200">
                  open overview →
                </Link>
              </article>
            </div>
          </Panel>

          <Panel
            title="Operator Shortcuts"
            description="Quick links to API docs and topology contexts from the HUD."
          >
            <div className="flex flex-wrap gap-2 text-sm">
              <Link
                href="https://codex-gateway.hack.gy/openapi"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
              >
                <BookOpen size={14} />
                OpenAPI Explorer
              </Link>
              <Link
                href="/topology"
                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
              >
                topology graph
              </Link>
              <Link
                href="/webhooks"
                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
              >
                webhook subscriptions
              </Link>
            </div>
          </Panel>

          <Panel title="Recent Request Errors">
            {snapshot.requestErrors.length === 0 ? (
              <EmptyState text="No API request errors in this snapshot." />
            ) : (
              <ul className="space-y-2 text-sm">
                {snapshot.requestErrors.map((requestError) => (
                  <li
                    key={`${requestError.endpoint}:${requestError.message}`}
                    className="rounded-md border border-rose-500/30 bg-rose-950/20 px-3 py-2"
                  >
                    <p className="font-mono text-xs text-rose-200">{requestError.endpoint}</p>
                    <p className="text-rose-100">{requestError.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
