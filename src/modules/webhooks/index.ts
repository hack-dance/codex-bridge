import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

const webhookScopeBody = t.Optional(
  t.Object({
    laneId: t.Optional(t.String()),
    laneIds: t.Optional(t.Array(t.String())),
    threadId: t.Optional(t.String()),
    threadIds: t.Optional(t.Array(t.String())),
    sessionId: t.Optional(t.String()),
    sessionIds: t.Optional(t.Array(t.String())),
  })
);

const webhookBody = t.Object({
  url: t.String({ format: "uri" }),
  events: t.Optional(t.Array(t.String())),
  enabled: t.Optional(t.Boolean()),
  secret: t.Optional(t.String()),
  scope: webhookScopeBody,
});

const webhookPatchBody = t.Object({
  url: t.Optional(t.String({ format: "uri" })),
  events: t.Optional(t.Array(t.String())),
  enabled: t.Optional(t.Boolean()),
  secret: t.Optional(t.String()),
  scope: webhookScopeBody,
});

const webhookParams = t.Object({
  id: t.String(),
});

interface WebhookScopeInput {
  laneId?: string;
  laneIds?: string[];
  threadId?: string;
  threadIds?: string[];
  sessionId?: string;
  sessionIds?: string[];
}

interface NormalizedWebhookScope {
  laneIds: string[];
  threadIds: string[];
  sessionIds: string[];
}

const normalizeIds = ({
  values,
  single,
}: {
  values?: string[];
  single?: string;
}): string[] => {
  const dedup = new Set<string>();
  const maybeAdd = (value?: string) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    dedup.add(trimmed);
  };
  maybeAdd(single);
  for (const value of values ?? []) {
    maybeAdd(value);
  }
  return [...dedup];
};

const normalizeWebhookScope = ({
  scope,
}: {
  scope?: WebhookScopeInput;
}): NormalizedWebhookScope | undefined => {
  if (!scope) {
    return undefined;
  }
  const normalized = {
    laneIds: normalizeIds({ values: scope.laneIds, single: scope.laneId }),
    threadIds: normalizeIds({
      values: scope.threadIds,
      single: scope.threadId,
    }),
    sessionIds: normalizeIds({
      values: scope.sessionIds,
      single: scope.sessionId,
    }),
  };
  if (
    normalized.laneIds.length === 0 &&
    normalized.threadIds.length === 0 &&
    normalized.sessionIds.length === 0
  ) {
    return undefined;
  }
  return normalized;
};

const toSubscriptionScopeKinds = ({
  scope,
}: {
  scope?: NormalizedWebhookScope;
}): string[] => {
  if (!scope) {
    return ["global"];
  }
  const kinds: string[] = [];
  if (scope.laneIds.length > 0) {
    kinds.push("lane");
  }
  if (scope.threadIds.length > 0) {
    kinds.push("thread");
  }
  if (scope.sessionIds.length > 0) {
    kinds.push("session");
  }
  return kinds.length > 0 ? kinds : ["global"];
};

const withScopeMeta = <T extends { scope?: NormalizedWebhookScope }>({
  subscription,
}: {
  subscription: T;
}) => ({
  ...subscription,
  scopeKinds: toSubscriptionScopeKinds({ scope: subscription.scope }),
});

export const webhooksModule = new Elysia({ name: "webhooks-module" })
  .get(
    "/webhooks",
    () => ({
      subscriptions: [...runtime.webhookSubscriptions.values()].map(
        (subscription) => withScopeMeta({ subscription })
      ),
    }),
    {
      detail: {
        summary: "List webhook subscriptions",
        tags: ["webhooks"],
      },
    }
  )
  .post(
    "/webhooks",
    async ({ body, status }) => {
      const now = runtime.nowIso();
      const normalizedScope = normalizeWebhookScope({
        scope: body.scope as WebhookScopeInput | undefined,
      });
      const subscription = {
        id: `wh_${crypto.randomUUID()}`,
        url: String(body.url),
        events: body.events?.map(String) ?? ["*"],
        enabled: body.enabled !== false,
        scope: normalizedScope,
        secret: body.secret ? String(body.secret) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      runtime.webhookSubscriptions.set(subscription.id, subscription);
      await runtime.persistWebhooks();
      return status(201, { subscription: withScopeMeta({ subscription }) });
    },
    {
      detail: {
        summary: "Create webhook subscription",
        tags: ["webhooks"],
      },
      body: webhookBody,
    }
  )
  .patch(
    "/webhooks/:id",
    async ({ params, body, status }) => {
      const subscription = runtime.webhookSubscriptions.get(params.id);
      if (!subscription) {
        return status(404, { error: "webhook_not_found" });
      }
      if (body.url !== undefined) {
        subscription.url = String(body.url);
      }
      if (body.events !== undefined) {
        subscription.events = body.events.map(String);
      }
      if (body.enabled !== undefined) {
        subscription.enabled = Boolean(body.enabled);
      }
      if (body.secret !== undefined) {
        subscription.secret = body.secret ? String(body.secret) : undefined;
      }
      if (body.scope !== undefined) {
        subscription.scope = normalizeWebhookScope({
          scope: body.scope as WebhookScopeInput | undefined,
        });
      }
      subscription.updatedAt = runtime.nowIso();
      await runtime.persistWebhooks();
      return { subscription: withScopeMeta({ subscription }) };
    },
    {
      detail: {
        summary: "Update webhook subscription",
        tags: ["webhooks"],
      },
      params: webhookParams,
      body: webhookPatchBody,
    }
  )
  .delete(
    "/webhooks/:id",
    async ({ params, status }) => {
      const existed = runtime.webhookSubscriptions.delete(params.id);
      if (!existed) {
        return status(404, { error: "webhook_not_found" });
      }
      await runtime.persistWebhooks();
      return { ok: true };
    },
    {
      detail: {
        summary: "Delete webhook subscription",
        tags: ["webhooks"],
      },
      params: webhookParams,
    }
  )
  .post(
    "/webhooks/:id/test",
    async ({ params, status }) => {
      const subscription = runtime.webhookSubscriptions.get(params.id);
      if (!subscription) {
        return status(404, { error: "webhook_not_found" });
      }
      const event = {
        eventId: crypto.randomUUID(),
        laneId: "webhook-test",
        type: "webhook.test",
        ts: runtime.nowIso(),
        severity: "info" as const,
        payload: { note: "manual test" },
      };
      await runtime.dispatchWebhooks(event);
      return { ok: true, subscription: withScopeMeta({ subscription }) };
    },
    {
      detail: {
        summary: "Trigger test webhook delivery",
        tags: ["webhooks"],
      },
      params: webhookParams,
    }
  );
