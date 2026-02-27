import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

export const healthModule = new Elysia({ name: "health-module" })
  .get(
    "/health",
    () => ({
      ok: true,
      service: "oai-app-proxy",
      version: runtime.APP_VERSION,
      lanes: runtime.lanes.size,
      watcher: runtime.getWatcherState(),
      defaultSurfacePolicy: "any",
    }),
    {
      detail: {
        summary: "Health check",
        tags: ["health"],
      },
      response: t.Object({
        ok: t.Boolean(),
        service: t.String(),
        version: t.String(),
        lanes: t.Number(),
        watcher: t.Object({
          running: t.Boolean(),
          intervalSec: t.Number(),
        }),
        defaultSurfacePolicy: t.String(),
      }),
    }
  )
  .get("/events/stream", () => runtime.createEventsStreamResponse(), {
    detail: {
      summary: "Server-sent events stream",
      tags: ["events"],
    },
    response: t.Any(),
  });
