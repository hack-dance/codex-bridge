"use client"

import { RefreshCw, Search } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

import { ActionButton, Banner, EmptyState, Panel } from "@/components/hud-primitives"
import { buildProjectSummaries } from "@/lib/project-summary"
import { useDashboardSnapshot } from "@/lib/use-dashboard-snapshot"

export default function ProjectsPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } = useDashboardSnapshot()
  const [search, setSearch] = useState("")

  const projects = useMemo(() => buildProjectSummaries({ snapshot }), [snapshot])
  const threadNamesByProject = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const thread of snapshot?.threads ?? []) {
      const projectName =
        typeof thread.projectName === "string" && thread.projectName.trim().length > 0
          ? thread.projectName
          : "Unassigned"
      const list = map.get(projectName) ?? []
      if (!list.includes(thread.displayName)) {
        list.push(thread.displayName)
      }
      map.set(projectName, list)
    }
    return map
  }, [snapshot?.threads])
  const filteredProjects = useMemo(() => {
    const lowered = search.trim().toLowerCase()
    if (!lowered) {
      return projects
    }
    return projects.filter((project) => {
      const threadSamples = threadNamesByProject.get(project.projectName) ?? []
      const haystack = [project.projectName, ...threadSamples].join(" ").toLowerCase()
      return haystack.includes(lowered)
    })
  }, [projects, search, threadNamesByProject])

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-zinc-400">
            Global project index across threads, lanes, and running sessions.
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

      <Panel title={`All Projects (${filteredProjects.length})`}>
        <div className="mb-3">
          <label className="flex h-9 min-w-[340px] items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100">
            <Search size={14} className="text-zinc-500" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search project names..."
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
            />
          </label>
        </div>

        {isLoading && !snapshot ? (
          <p className="text-sm text-zinc-400">Loading projects...</p>
        ) : filteredProjects.length === 0 ? (
          <EmptyState text="No projects match the active filter." />
        ) : (
          <div className="max-h-[72vh] overflow-auto rounded-lg border border-zinc-800">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Project</th>
                  <th className="px-3 py-2">Threads</th>
                  <th className="px-3 py-2">Lanes</th>
                  <th className="px-3 py-2">Sessions</th>
                  <th className="px-3 py-2">Live</th>
                  <th className="px-3 py-2">Issues</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredProjects.map((project) => {
                  const threadSamples = threadNamesByProject.get(project.projectName) ?? []
                  return (
                    <tr key={project.projectId} className="align-top hover:bg-zinc-900/60">
                      <td className="px-3 py-2">
                        <p className="text-xs text-zinc-100">{project.projectName}</p>
                        <p className="mono mt-1 text-[11px] text-zinc-500">{project.projectId}</p>
                        {threadSamples.length > 0 ? (
                          <p className="mt-1 text-xs text-zinc-400">
                            {threadSamples.slice(0, 2).join(" · ")}
                            {threadSamples.length > 2 ? ` +${threadSamples.length - 2}` : ""}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-300">{project.threadCount}</td>
                      <td className="px-3 py-2 text-xs text-zinc-300">{project.laneCount}</td>
                      <td className="px-3 py-2 text-xs text-zinc-300">{project.sessionCount}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${
                            project.liveThreadCount > 0
                              ? "bg-cyan-100 text-cyan-900"
                              : "bg-zinc-200 text-zinc-700"
                          }`}
                        >
                          {project.liveThreadCount}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${
                            project.problemLaneCount > 0
                              ? "bg-amber-100 text-amber-900"
                              : "bg-zinc-200 text-zinc-700"
                          }`}
                        >
                          {project.problemLaneCount}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <Link
                            href={`/topology?search=${encodeURIComponent(project.projectName)}`}
                            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                          >
                            topology
                          </Link>
                          <Link
                            href={`/threads?search=${encodeURIComponent(project.projectName)}`}
                            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                          >
                            threads
                          </Link>
                          <Link
                            href={`/lanes?search=${encodeURIComponent(project.projectName)}`}
                            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                          >
                            lanes
                          </Link>
                        </div>
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
