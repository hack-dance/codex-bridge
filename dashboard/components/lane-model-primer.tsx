import Link from "next/link";

import { laneStatusReference } from "@/lib/dashboard-ui";

export const LaneModelPrimer = ({
  title = "Execution model",
  compact = false,
  showStatusLegend = true,
}: {
  title?: string;
  compact?: boolean;
  showStatusLegend?: boolean;
}) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
    <p className="mono text-[11px] text-zinc-500 uppercase tracking-[0.16em]">
      {title}
    </p>
    <p className="mt-2 text-sm text-zinc-300">
      <span className="font-medium text-zinc-100">Project</span> owns workspace
      context.
      <span className="mx-1 text-zinc-500">→</span>
      <span className="font-medium text-zinc-100">Thread</span> is conversation
      lineage.
      <span className="mx-1 text-zinc-500">→</span>
      <span className="font-medium text-zinc-100">Lane</span> is the execution
      rail attached to a thread.
      <span className="mx-1 text-zinc-500">→</span>
      <span className="font-medium text-zinc-100">Session</span> is the live
      process currently serving that lane.
    </p>
    {compact ? null : (
      <p className="mt-2 text-xs text-zinc-400">
        Sub-agents are represented as child threads under their parent thread.
        Track structure in{" "}
        <Link className="text-zinc-200 hover:text-zinc-50" href="/topology">
          topology
        </Link>
        , control lane lifecycle in{" "}
        <Link className="text-zinc-200 hover:text-zinc-50" href="/lanes">
          lanes
        </Link>
        .
      </p>
    )}
    {showStatusLegend ? (
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {laneStatusReference.map((entry) => (
          <article
            className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1.5"
            key={entry.status}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex rounded px-2 py-0.5 font-semibold text-[11px] ${entry.className}`}
              >
                {entry.status}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              {entry.description}
            </p>
          </article>
        ))}
      </div>
    ) : null}
  </div>
);
