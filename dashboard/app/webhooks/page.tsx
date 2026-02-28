"use client";

import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  ActionButton,
  Banner,
  EmptyState,
  Panel,
  RowActionMenu,
  RowActionMenuButton,
} from "@/components/hud-primitives";
import {
  formatIso,
  type WebhookHealth,
  webhookHealth,
  webhookHealthClassName,
} from "@/lib/dashboard-ui";
import {
  runDashboardAction,
  useDashboardSnapshot,
} from "@/lib/use-dashboard-snapshot";

interface ScopeSummary {
  kinds: string[];
  targets: string[];
}

const summarizeScope = ({
  subscription,
}: {
  subscription: {
    scopeKinds?: string[];
    scope?: {
      laneIds: string[];
      threadIds: string[];
      sessionIds: string[];
    };
  };
}): ScopeSummary => {
  const kinds =
    subscription.scopeKinds && subscription.scopeKinds.length > 0
      ? subscription.scopeKinds
      : ["global"];
  const targets = [
    ...(subscription.scope?.laneIds ?? []).map((target) => `lane:${target}`),
    ...(subscription.scope?.threadIds ?? []).map(
      (target) => `thread:${target}`
    ),
    ...(subscription.scope?.sessionIds ?? []).map(
      (target) => `session:${target}`
    ),
  ];
  return {
    kinds,
    targets: targets.length > 0 ? targets : ["all"],
  };
};

const healthOrder: WebhookHealth[] = [
  "failing",
  "stale",
  "disabled",
  "idle",
  "active",
];

const parseTokenList = ({ value }: { value: string }): string[] => {
  const dedupe = new Set<string>();
  for (const token of value.split(/[,\s]+/)) {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      dedupe.add(trimmed);
    }
  }
  return [...dedupe];
};

const addToken = ({
  input,
  token,
}: {
  input: string;
  token: string;
}): string => {
  const values = parseTokenList({ value: input });
  if (!values.includes(token)) {
    values.push(token);
  }
  return values.join(", ");
};

export default function WebhooksPage() {
  const { snapshot, error, isLoading, isRefreshing, refreshSnapshot } =
    useDashboardSnapshot();
  const [isCreateOpen, setIsCreateOpen] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    return (
      params.get("create") === "1" ||
      params.has("laneId") ||
      params.has("threadId") ||
      params.has("sessionId")
    );
  });
  const [search, setSearch] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("search") ?? "";
  });
  const [createUrl, setCreateUrl] = useState("");
  const [createEvents, setCreateEvents] = useState("*");
  const [createEnabled, setCreateEnabled] = useState(true);
  const [createSecret, setCreateSecret] = useState("");
  const [scopeMode, setScopeMode] = useState<"global" | "scoped">(() => {
    if (typeof window === "undefined") {
      return "global";
    }
    const params = new URLSearchParams(window.location.search);
    return params.has("laneId") ||
      params.has("threadId") ||
      params.has("sessionId")
      ? "scoped"
      : "global";
  });
  const [scopeLaneIds, setScopeLaneIds] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("laneId") ?? "";
  });
  const [scopeThreadIds, setScopeThreadIds] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("threadId") ?? "";
  });
  const [scopeSessionIds, setScopeSessionIds] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return new URLSearchParams(window.location.search).get("sessionId") ?? "";
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const laneById = useMemo(
    () => new Map((snapshot?.lanes ?? []).map((lane) => [lane.laneId, lane])),
    [snapshot?.lanes]
  );
  const threadById = useMemo(
    () =>
      new Map((snapshot?.threads ?? []).map((thread) => [thread.id, thread])),
    [snapshot?.threads]
  );
  const laneSuggestions = useMemo(
    () =>
      (snapshot?.lanes ?? [])
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10),
    [snapshot?.lanes]
  );
  const threadSuggestions = useMemo(
    () =>
      (snapshot?.threads ?? [])
        .slice()
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        .slice(0, 10),
    [snapshot?.threads]
  );

  const subscriptions = useMemo(() => {
    const list = snapshot?.webhooks ?? [];
    const lowered = search.trim().toLowerCase();
    const filtered = lowered
      ? list.filter((subscription) => {
          const scope = summarizeScope({ subscription });
          const scopeLabels = scope.targets.map((target) => {
            if (target.startsWith("lane:")) {
              return laneById.get(target.slice(5))?.displayName ?? "";
            }
            if (target.startsWith("thread:")) {
              return threadById.get(target.slice(7))?.displayName ?? "";
            }
            return "";
          });
          const haystack = [
            subscription.id,
            subscription.url,
            ...subscription.events,
            ...scope.kinds,
            ...scope.targets,
            ...scopeLabels,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(lowered);
        })
      : list;
    return [...filtered].sort((left, right) => {
      const leftHealth = webhookHealth({
        enabled: left.enabled,
        lastDeliveryAt: left.lastDeliveryAt,
        lastError: left.lastError,
      });
      const rightHealth = webhookHealth({
        enabled: right.enabled,
        lastDeliveryAt: right.lastDeliveryAt,
        lastError: right.lastError,
      });
      return healthOrder.indexOf(leftHealth) - healthOrder.indexOf(rightHealth);
    });
  }, [laneById, snapshot?.webhooks, search, threadById]);

  const runAction = async ({
    payload,
    actionKey,
    successMessage,
  }: {
    payload: Record<string, unknown>;
    actionKey: string;
    successMessage: string;
  }): Promise<boolean> => {
    setPendingActionKey(actionKey);
    setActionError(null);
    setActionMessage(null);
    try {
      await runDashboardAction({ payload });
      setActionMessage(successMessage);
      await refreshSnapshot({ isPoll: false });
      return true;
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Action failed";
      setActionError(message);
      return false;
    } finally {
      setPendingActionKey(null);
    }
  };

  const createWebhook = async () => {
    const url = createUrl.trim();
    if (!url) {
      setActionError("Webhook URL is required");
      setActionMessage(null);
      return;
    }
    const payload: Record<string, unknown> = {
      action: "webhook-create",
      url,
      enabled: createEnabled,
    };
    const events = parseTokenList({ value: createEvents });
    if (events.length > 0) {
      payload.events = events;
    }
    const secret = createSecret.trim();
    if (secret.length > 0) {
      payload.secret = secret;
    }

    if (scopeMode === "scoped") {
      const laneIds = parseTokenList({ value: scopeLaneIds });
      const threadIds = parseTokenList({ value: scopeThreadIds });
      const sessionIds = parseTokenList({ value: scopeSessionIds });
      payload.scope = {
        laneIds,
        threadIds,
        sessionIds,
      };
    }

    const didCreate = await runAction({
      actionKey: "webhook-create",
      successMessage: "Webhook subscription created",
      payload,
    });
    if (!didCreate) {
      return;
    }

    setCreateUrl("");
    setCreateEvents("*");
    setCreateSecret("");
    setCreateEnabled(true);
    setScopeMode("global");
    setScopeLaneIds("");
    setScopeThreadIds("");
    setScopeSessionIds("");
    setIsCreateOpen(false);
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl">Webhooks</h1>
          <p className="text-sm text-zinc-400">
            Hybrid subscriptions with global, lane, thread, and session
            targeting.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton
            icon={<Plus size={14} />}
            label={isCreateOpen ? "Hide create" : "Create webhook"}
            onClick={() => {
              setIsCreateOpen((previous) => !previous);
            }}
          />
          <ActionButton
            busy={isRefreshing}
            icon={
              <RefreshCw
                className={isRefreshing ? "animate-spin" : ""}
                size={14}
              />
            }
            label={isRefreshing ? "Refreshing..." : "Refresh"}
            onClick={() => {
              refreshSnapshot({ isPoll: false }).catch(() => undefined);
            }}
          />
        </div>
      </header>

      {error ? <Banner text={error} tone="error" /> : null}
      {actionError ? <Banner text={actionError} tone="error" /> : null}
      {actionMessage ? <Banner text={actionMessage} tone="success" /> : null}
      {deleteArmedId ? (
        <p className="text-amber-300 text-xs">
          Delete is armed for webhook{" "}
          <span className="mono">{deleteArmedId}</span>. Click delete again to
          confirm.
        </p>
      ) : null}

      {isCreateOpen ? (
        <Panel
          description="Create global webhooks or scope delivery to lane/thread/session entities."
          title="Create subscription"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              destination URL
              <input
                className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                onChange={(event) => setCreateUrl(event.target.value)}
                placeholder="https://example.com/webhooks/codex"
                type="url"
                value={createUrl}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              events (comma-separated)
              <input
                className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                onChange={(event) => setCreateEvents(event.target.value)}
                placeholder="* or lane.status.changed, lane.error"
                type="text"
                value={createEvents}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              secret (optional)
              <input
                className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                onChange={(event) => setCreateSecret(event.target.value)}
                placeholder="shared signing secret"
                type="text"
                value={createSecret}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                checked={createEnabled}
                onChange={(event) => setCreateEnabled(event.target.checked)}
                type="checkbox"
              />
              enabled on create
            </label>
          </div>

          <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
            <p className="mono text-[11px] text-zinc-500 uppercase tracking-[0.16em]">
              scope
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <label className="inline-flex items-center gap-2 text-zinc-300">
                <input
                  checked={scopeMode === "global"}
                  name="scope-mode"
                  onChange={() => setScopeMode("global")}
                  type="radio"
                />
                global (all entities)
              </label>
              <label className="inline-flex items-center gap-2 text-zinc-300">
                <input
                  checked={scopeMode === "scoped"}
                  name="scope-mode"
                  onChange={() => setScopeMode("scoped")}
                  type="radio"
                />
                scoped (lane/thread/session)
              </label>
            </div>

            {scopeMode === "scoped" ? (
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-zinc-500">
                  lane IDs
                  <input
                    className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                    onChange={(event) => setScopeLaneIds(event.target.value)}
                    placeholder="lane_a, lane_b"
                    type="text"
                    value={scopeLaneIds}
                  />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {laneSuggestions.slice(0, 6).map((lane) => (
                      <button
                        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
                        key={`scope-lane:${lane.laneId}`}
                        onClick={() => {
                          setScopeLaneIds((previous) =>
                            addToken({
                              input: previous,
                              token: lane.laneId,
                            })
                          );
                        }}
                        type="button"
                      >
                        {lane.displayName}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-500">
                  thread IDs
                  <input
                    className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                    onChange={(event) => setScopeThreadIds(event.target.value)}
                    placeholder="thread_a, thread_b"
                    type="text"
                    value={scopeThreadIds}
                  />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {threadSuggestions.slice(0, 6).map((thread) => (
                      <button
                        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
                        key={`scope-thread:${thread.id}`}
                        onClick={() => {
                          setScopeThreadIds((previous) =>
                            addToken({
                              input: previous,
                              token: thread.id,
                            })
                          );
                        }}
                        type="button"
                      >
                        {thread.displayName}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-500">
                  session IDs
                  <input
                    className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                    onChange={(event) => setScopeSessionIds(event.target.value)}
                    placeholder="session_a, session_b"
                    type="text"
                    value={scopeSessionIds}
                  />
                  <p className="text-[11px] text-zinc-500">
                    Use explicit session identifiers when available from runtime
                    logs or API payloads.
                  </p>
                </label>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              busy={pendingActionKey === "webhook-create"}
              label={
                pendingActionKey === "webhook-create"
                  ? "Creating..."
                  : "Create subscription"
              }
              onClick={() => {
                createWebhook().catch(() => undefined);
              }}
            />
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-300 hover:bg-zinc-800"
              onClick={() => {
                setCreateUrl("");
                setCreateEvents("*");
                setCreateSecret("");
                setCreateEnabled(true);
                setScopeMode("global");
                setScopeLaneIds("");
                setScopeThreadIds("");
                setScopeSessionIds("");
              }}
              type="button"
            >
              reset
            </button>
          </div>
        </Panel>
      ) : null}

      <Panel title={`Subscriptions (${subscriptions.length})`}>
        <div className="mb-3">
          <label className="flex h-9 min-w-[360px] items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100">
            <Search className="text-zinc-500" size={14} />
            <input
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by id, destination, event, scope target..."
              type="search"
              value={search}
            />
          </label>
        </div>

        {isLoading && !snapshot ? (
          <p className="text-sm text-zinc-400">Loading webhooks...</p>
        ) : subscriptions.length === 0 ? (
          <EmptyState text="No webhook subscriptions found." />
        ) : (
          <div className="max-h-[72vh] overflow-auto rounded-lg border border-zinc-800">
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
              <thead className="sticky top-0 bg-zinc-900/95 text-left text-xs text-zinc-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">Webhook</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Events</th>
                  <th className="px-3 py-2">Health</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {subscriptions.map((subscription) => {
                  const health = webhookHealth({
                    enabled: subscription.enabled,
                    lastDeliveryAt: subscription.lastDeliveryAt,
                    lastError: subscription.lastError,
                  });
                  const scope = summarizeScope({ subscription });
                  return (
                    <tr
                      className="align-top hover:bg-zinc-900/60"
                      key={subscription.id}
                    >
                      <td className="px-3 py-2">
                        <p className="font-mono text-xs text-zinc-200">
                          {subscription.id}
                        </p>
                        <p className="max-w-[300px] break-all text-xs text-zinc-400">
                          {subscription.url}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {scope.kinds.map((kind) => (
                            <span
                              className="rounded bg-indigo-950/60 px-2 py-0.5 text-[11px] text-indigo-200"
                              key={`${subscription.id}:${kind}`}
                            >
                              {kind}
                            </span>
                          ))}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {scope.targets.slice(0, 4).map((target) => (
                            <Link
                              className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                              href={
                                target.startsWith("lane:")
                                  ? `/lanes?search=${encodeURIComponent(target.slice(5))}`
                                  : target.startsWith("thread:")
                                    ? `/threads?search=${encodeURIComponent(target.slice(7))}`
                                    : `/topology?search=${encodeURIComponent(target)}`
                              }
                              key={`${subscription.id}:target:${target}`}
                            >
                              {target.startsWith("lane:")
                                ? `${target} (${laneById.get(target.slice(5))?.displayName ?? "unknown"})`
                                : target.startsWith("thread:")
                                  ? `${target} (${threadById.get(target.slice(7))?.displayName ?? "unknown"})`
                                  : target}
                            </Link>
                          ))}
                          {scope.targets.length > 4 ? (
                            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                              +{scope.targets.length - 4}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-300">
                        <div className="flex flex-wrap gap-1">
                          {subscription.events.map((eventType) => (
                            <span
                              className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                              key={`${subscription.id}:${eventType}`}
                            >
                              {eventType}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 font-semibold text-xs ${webhookHealthClassName({ health })}`}
                        >
                          {health}
                        </span>
                        <p className="mt-1 text-xs text-zinc-500">
                          delivered{" "}
                          {formatIso({ value: subscription.lastDeliveryAt })}
                        </p>
                        {subscription.lastError ? (
                          <p className="mt-1 max-w-[240px] text-rose-300 text-xs">
                            {subscription.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">
                        {formatIso({ value: subscription.updatedAt })}
                      </td>
                      <td className="px-3 py-2">
                        <RowActionMenu
                          label={`Actions for webhook ${subscription.id}`}
                        >
                          <RowActionMenuButton
                            busy={
                              pendingActionKey ===
                              `webhook-test:${subscription.id}`
                            }
                            label="Test webhook"
                            onClick={() => {
                              runAction({
                                actionKey: `webhook-test:${subscription.id}`,
                                successMessage: `Webhook ${subscription.id} test triggered`,
                                payload: {
                                  action: "webhook-test",
                                  id: subscription.id,
                                },
                              }).catch(() => undefined);
                            }}
                          />
                          <RowActionMenuButton
                            busy={
                              pendingActionKey ===
                              `webhook-toggle:${subscription.id}`
                            }
                            label={
                              subscription.enabled
                                ? "Disable webhook"
                                : "Enable webhook"
                            }
                            onClick={() => {
                              runAction({
                                actionKey: `webhook-toggle:${subscription.id}`,
                                successMessage: `Webhook ${subscription.id} updated`,
                                payload: {
                                  action: "webhook-toggle",
                                  id: subscription.id,
                                  enabled: !subscription.enabled,
                                },
                              }).catch(() => undefined);
                            }}
                          />
                          <RowActionMenuButton
                            busy={
                              pendingActionKey ===
                              `webhook-delete:${subscription.id}`
                            }
                            icon={<Trash2 size={12} />}
                            label={
                              deleteArmedId === subscription.id
                                ? "Confirm delete webhook"
                                : "Delete webhook"
                            }
                            onClick={() => {
                              if (deleteArmedId !== subscription.id) {
                                setDeleteArmedId(subscription.id);
                                return;
                              }
                              setDeleteArmedId(null);
                              runAction({
                                actionKey: `webhook-delete:${subscription.id}`,
                                successMessage: `Webhook ${subscription.id} deleted`,
                                payload: {
                                  action: "webhook-delete",
                                  id: subscription.id,
                                },
                              }).catch(() => undefined);
                            }}
                            variant="danger"
                          />
                        </RowActionMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
