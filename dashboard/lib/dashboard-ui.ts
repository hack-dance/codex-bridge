export const laneStatusReference = [
  {
    status: "idle",
    className: "bg-zinc-100 text-zinc-800",
    description: "Lane exists, but no session or active turn is running.",
  },
  {
    status: "starting",
    className: "bg-blue-100 text-blue-800",
    description: "Session bootstrap in progress.",
  },
  {
    status: "running",
    className: "bg-emerald-100 text-emerald-800",
    description: "Lane has an active running session.",
  },
  {
    status: "needs_approval",
    className: "bg-amber-100 text-amber-800",
    description: "Paused and waiting for explicit approval.",
  },
  {
    status: "blocked",
    className: "bg-amber-100 text-amber-800",
    description: "Execution is blocked by an unmet condition or dependency.",
  },
  {
    status: "verifying",
    className: "bg-blue-100 text-blue-800",
    description: "Lane is performing verification steps.",
  },
  {
    status: "done",
    className: "bg-emerald-100 text-emerald-800",
    description: "Lane completed successfully.",
  },
  {
    status: "failed",
    className: "bg-rose-100 text-rose-800",
    description: "Lane ended due to an execution error.",
  },
  {
    status: "interrupted",
    className: "bg-amber-100 text-amber-800",
    description: "Lane stopped before completion.",
  },
] as const

const laneStatusClassNameByStatus = new Map<string, string>(
  laneStatusReference.map((entry) => [entry.status, entry.className])
)

export const laneStatusClassName = ({ status }: { status: string }): string =>
  laneStatusClassNameByStatus.get(status) ?? "bg-zinc-100 text-zinc-800"

export const laneOwnershipClassName = ({ ownershipType }: { ownershipType: string }): string => {
  if (ownershipType === "thread-owned") {
    return "bg-indigo-100 text-indigo-800"
  }
  if (ownershipType === "project-owned") {
    return "bg-cyan-100 text-cyan-800"
  }
  return "bg-zinc-200 text-zinc-700"
}

export const runtimeOriginLabel = ({
  originator,
  sourceLabel,
  surface,
}: {
  originator?: string | null
  sourceLabel?: string | null
  surface?: string | null
}): string => {
  const trimmedOriginator = originator?.trim()
  if (trimmedOriginator) {
    return trimmedOriginator
  }
  const trimmedSourceLabel = sourceLabel?.trim()
  if (trimmedSourceLabel) {
    return trimmedSourceLabel
  }
  const trimmedSurface = surface?.trim()
  if (trimmedSurface) {
    return trimmedSurface
  }
  return "unknown"
}

export const formatIso = ({ value }: { value: string | null | undefined }): string => {
  if (!value) {
    return "—"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

export const formatRelativeSeconds = ({ unixSeconds }: { unixSeconds?: number }): string => {
  if (typeof unixSeconds !== "number") {
    return "—"
  }
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds)
  if (delta < 60) {
    return `${delta}s ago`
  }
  const minutes = Math.floor(delta / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export const toDisplayValue = ({
  value,
  fallback = "—",
}: {
  value: unknown
  fallback?: string
}): string => {
  if (value === null || value === undefined) {
    return fallback
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : fallback
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  try {
    const serialized = JSON.stringify(value)
    return serialized && serialized !== "{}" ? serialized : fallback
  } catch {
    return fallback
  }
}

export type WebhookHealth = "active" | "failing" | "disabled" | "stale" | "idle"

const toEpochMs = ({ value }: { value?: string | null }): number | null => {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export const webhookHealth = ({
  enabled,
  lastError,
  lastDeliveryAt,
}: {
  enabled: boolean
  lastError?: string
  lastDeliveryAt?: string
}): WebhookHealth => {
  if (!enabled) {
    return "disabled"
  }
  if (lastError) {
    return "failing"
  }
  const lastDeliveryMs = toEpochMs({ value: lastDeliveryAt })
  if (lastDeliveryMs === null) {
    return "idle"
  }
  const elapsedMs = Date.now() - lastDeliveryMs
  if (elapsedMs > 4 * 60 * 60 * 1000) {
    return "stale"
  }
  return "active"
}

export const webhookHealthClassName = ({ health }: { health: WebhookHealth }): string => {
  if (health === "active") {
    return "bg-emerald-100 text-emerald-800"
  }
  if (health === "failing") {
    return "bg-rose-100 text-rose-800"
  }
  if (health === "disabled") {
    return "bg-zinc-200 text-zinc-700"
  }
  if (health === "stale") {
    return "bg-amber-100 text-amber-800"
  }
  return "bg-blue-100 text-blue-800"
}
