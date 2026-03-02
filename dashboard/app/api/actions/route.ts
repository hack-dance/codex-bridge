import { NextResponse } from "next/server"

import { resolveBridgeBaseUrl } from "@/lib/dashboard-data"

type ActionName =
  | "reconcile-stale"
  | "watch-start"
  | "watch-stop"
  | "watch-tick"
  | "lane-sync"
  | "lane-start-session"
  | "lane-stop-session"
  | "lane-delete"
  | "lane-cleanup"
  | "thread-archive"
  | "webhook-test"
  | "webhook-create"
  | "webhook-toggle"
  | "webhook-delete"

interface BridgeRequestResult {
  status: number
  payload: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toStringValue = ({ value }: { value: unknown }): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const toBooleanValue = ({ value, fallback }: { value: unknown; fallback: boolean }): boolean =>
  typeof value === "boolean" ? value : fallback

const toNumberValue = ({ value, fallback }: { value: unknown; fallback: number }): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const toLaneReadinessMode = ({
  value,
}: {
  value: unknown
}): "strict" | "lenient" | undefined =>
  value === "strict" || value === "lenient" ? value : undefined

const toLaneSurface = ({
  value,
}: {
  value: unknown
}): "mac-app" | "vscode" | "cli" | "any" | undefined =>
  value === "mac-app" || value === "vscode" || value === "cli" || value === "any" ? value : undefined

const toStringArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value
    .map((item) => toStringValue({ value: item }))
    .filter((item): item is string => item !== null)
  return items.length > 0 ? items : undefined
}

const toWebhookScope = ({
  value,
}: {
  value: unknown
}):
  | {
      laneId?: string
      laneIds?: string[]
      threadId?: string
      threadIds?: string[]
      sessionId?: string
      sessionIds?: string[]
    }
  | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const scope = {
    laneId: toStringValue({ value: value.laneId }) ?? undefined,
    laneIds: toStringArray({ value: value.laneIds }),
    threadId: toStringValue({ value: value.threadId }) ?? undefined,
    threadIds: toStringArray({ value: value.threadIds }),
    sessionId: toStringValue({ value: value.sessionId }) ?? undefined,
    sessionIds: toStringArray({ value: value.sessionIds }),
  }
  const hasAnyScope =
    Boolean(scope.laneId) ||
    Boolean(scope.threadId) ||
    Boolean(scope.sessionId) ||
    Boolean(scope.laneIds?.length) ||
    Boolean(scope.threadIds?.length) ||
    Boolean(scope.sessionIds?.length)
  return hasAnyScope ? scope : undefined
}

const badRequest = ({ message }: { message: string }) =>
  NextResponse.json({ error: "invalid_request", message }, { status: 400 })

const bridgeRequest = async ({
  endpoint,
  method,
  body,
}: {
  endpoint: string
  method: "POST" | "PATCH" | "DELETE"
  body?: Record<string, unknown>
}): Promise<BridgeRequestResult> => {
  const baseUrl = resolveBridgeBaseUrl()

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    })

    const text = await response.text()
    if (!text.trim()) {
      return {
        status: response.status,
        payload: { ok: response.ok },
      }
    }

    try {
      return {
        status: response.status,
        payload: JSON.parse(text) as unknown,
      }
    } catch {
      return {
        status: response.status,
        payload: {
          ok: response.ok,
          body: text,
        },
      }
    }
  } catch (error) {
    return {
      status: 502,
      payload: {
        error: "bridge_request_failed",
        message: error instanceof Error ? error.message : "Unknown bridge request failure",
      },
    }
  }
}

export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = (await request.json()) as unknown
  } catch {
    return badRequest({ message: "Request body must be valid JSON" })
  }

  if (!isRecord(payload)) {
    return badRequest({ message: "Request body must be an object" })
  }

  const actionValue = toStringValue({ value: payload.action })
  if (!actionValue) {
    return badRequest({ message: "Missing action" })
  }

  const action = actionValue as ActionName

  if (action === "reconcile-stale") {
    const result = await bridgeRequest({
      endpoint: "/debug/reconcile-stale",
      method: "POST",
      body: {
        clearSyntheticRunningLanes: toBooleanValue({
          value: payload.clearSyntheticRunningLanes,
          fallback: true,
        }),
        clearOrphanedActiveTurns: toBooleanValue({
          value: payload.clearOrphanedActiveTurns,
          fallback: true,
        }),
      },
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "watch-start") {
    const result = await bridgeRequest({
      endpoint: "/watch/start",
      method: "POST",
      body: {
        intervalSec: toNumberValue({ value: payload.intervalSec, fallback: 15 }),
      },
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "watch-stop") {
    const result = await bridgeRequest({
      endpoint: "/watch/stop",
      method: "POST",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "watch-tick") {
    const result = await bridgeRequest({
      endpoint: "/watch/tick",
      method: "POST",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  const laneId = toStringValue({ value: payload.laneId })
  if (action === "lane-sync") {
    if (!laneId) {
      return badRequest({ message: "lane-sync requires laneId" })
    }
    const laneThreadId = toStringValue({ value: payload.threadId })
    const preferredSurface = toLaneSurface({ value: payload.preferredSurface })
    const requirePreferredSurface =
      typeof payload.requirePreferredSurface === "boolean" ? payload.requirePreferredSurface : undefined
    const body = {
      ...(laneThreadId ? { threadId: laneThreadId } : {}),
      ...(preferredSurface ? { preferredSurface } : {}),
      ...(requirePreferredSurface !== undefined ? { requirePreferredSurface } : {}),
    }
    const result = await bridgeRequest({
      endpoint: `/lanes/${laneId}/sync-from-codex`,
      method: "POST",
      body: Object.keys(body).length > 0 ? body : undefined,
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "lane-start-session") {
    if (!laneId) {
      return badRequest({ message: "lane-start-session requires laneId" })
    }
    const laneThreadId = toStringValue({ value: payload.threadId })
    const readinessMode = toLaneReadinessMode({ value: payload.readinessMode })
    const preferredSurface = toLaneSurface({ value: payload.preferredSurface })
    const requirePreferredSurface =
      typeof payload.requirePreferredSurface === "boolean" ? payload.requirePreferredSurface : undefined
    const waitForThreadResume =
      typeof payload.waitForThreadResume === "boolean" ? payload.waitForThreadResume : undefined
    const body = {
      ...(laneThreadId ? { threadId: laneThreadId } : {}),
      ...(readinessMode ? { readinessMode } : {}),
      ...(preferredSurface ? { preferredSurface } : {}),
      ...(requirePreferredSurface !== undefined ? { requirePreferredSurface } : {}),
      ...(waitForThreadResume !== undefined ? { waitForThreadResume } : {}),
    }
    const result = await bridgeRequest({
      endpoint: `/lanes/${laneId}/session/start`,
      method: "POST",
      body: Object.keys(body).length > 0 ? body : undefined,
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "lane-stop-session") {
    if (!laneId) {
      return badRequest({ message: "lane-stop-session requires laneId" })
    }
    const result = await bridgeRequest({
      endpoint: `/lanes/${laneId}/session/stop`,
      method: "POST",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "lane-delete") {
    if (!laneId) {
      return badRequest({ message: "lane-delete requires laneId" })
    }
    const result = await bridgeRequest({
      endpoint: `/lanes/${laneId}`,
      method: "DELETE",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "lane-cleanup") {
    const statuses = Array.isArray(payload.statuses)
      ? payload.statuses
          .map((value) => toStringValue({ value }))
          .filter((value): value is string => value !== null)
      : undefined
    const result = await bridgeRequest({
      endpoint: "/lanes/cleanup",
      method: "POST",
      body: {
        statuses,
        olderThanHours: toNumberValue({
          value: payload.olderThanHours,
          fallback: 24,
        }),
        syntheticOnly: toBooleanValue({
          value: payload.syntheticOnly,
          fallback: false,
        }),
        limit: toNumberValue({ value: payload.limit, fallback: 100 }),
        dryRun: toBooleanValue({ value: payload.dryRun, fallback: false }),
      },
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  const threadId = toStringValue({ value: payload.threadId })
  if (action === "thread-archive") {
    if (!threadId) {
      return badRequest({ message: "thread-archive requires threadId" })
    }
    const result = await bridgeRequest({
      endpoint: `/codex/threads/${threadId}/archive`,
      method: "POST",
      body: {},
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  const webhookId = toStringValue({ value: payload.id })
  if (action === "webhook-create") {
    const url = toStringValue({ value: payload.url })
    if (!url) {
      return badRequest({ message: "webhook-create requires url" })
    }
    const events = toStringArray({ value: payload.events })
    const secret = toStringValue({ value: payload.secret })
    const scope = toWebhookScope({ value: payload.scope })
    const body: Record<string, unknown> = {
      url,
      ...(events ? { events } : {}),
      ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
      ...(secret ? { secret } : {}),
      ...(scope ? { scope } : {}),
    }
    const result = await bridgeRequest({
      endpoint: "/webhooks",
      method: "POST",
      body,
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "webhook-test") {
    if (!webhookId) {
      return badRequest({ message: "webhook-test requires id" })
    }
    const result = await bridgeRequest({
      endpoint: `/webhooks/${webhookId}/test`,
      method: "POST",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "webhook-toggle") {
    if (!webhookId) {
      return badRequest({ message: "webhook-toggle requires id" })
    }
    if (typeof payload.enabled !== "boolean") {
      return badRequest({ message: "webhook-toggle requires boolean enabled" })
    }
    const result = await bridgeRequest({
      endpoint: `/webhooks/${webhookId}`,
      method: "PATCH",
      body: { enabled: payload.enabled },
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  if (action === "webhook-delete") {
    if (!webhookId) {
      return badRequest({ message: "webhook-delete requires id" })
    }
    const result = await bridgeRequest({
      endpoint: `/webhooks/${webhookId}`,
      method: "DELETE",
    })
    return NextResponse.json(result.payload, { status: result.status })
  }

  return badRequest({ message: `Unsupported action: ${actionValue}` })
}
