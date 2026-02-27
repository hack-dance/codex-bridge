import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

const webhookBody = t.Object({
  url: t.String({ format: "uri" }),
  events: t.Optional(t.Array(t.String())),
  enabled: t.Optional(t.Boolean()),
  secret: t.Optional(t.String()),
});

const webhookPatchBody = t.Object({
  url: t.Optional(t.String({ format: "uri" })),
  events: t.Optional(t.Array(t.String())),
  enabled: t.Optional(t.Boolean()),
  secret: t.Optional(t.String()),
});

const webhookParams = t.Object({
  id: t.String(),
});

export const webhooksModule = new Elysia({ name: "webhooks-module" })
  .get(
    "/webhooks",
    () => ({ subscriptions: [...runtime.webhookSubscriptions.values()] }),
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
      const subscription = {
        id: `wh_${crypto.randomUUID()}`,
        url: String(body.url),
        events: body.events?.map(String) ?? ["*"],
        enabled: body.enabled !== false,
        secret: body.secret ? String(body.secret) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      runtime.webhookSubscriptions.set(subscription.id, subscription);
      await runtime.persistWebhooks();
      return status(201, { subscription });
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
      subscription.updatedAt = runtime.nowIso();
      await runtime.persistWebhooks();
      return { subscription };
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
      return { ok: true, subscription };
    },
    {
      detail: {
        summary: "Trigger test webhook delivery",
        tags: ["webhooks"],
      },
      params: webhookParams,
    }
  );
