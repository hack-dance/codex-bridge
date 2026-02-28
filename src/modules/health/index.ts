import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

export const healthModule = new Elysia({ name: "health-module" })
  .get(
    "/health",
    () => ({
      ok: true,
      service: "oai-app-proxy",
      version: runtime.APP_VERSION,
      codexAppServerVersion: runtime.CODEX_APP_SERVER_VERSION,
      codexBin: process.env.CODEX_BIN ?? "codex",
      codexAppServerWsUrl: process.env.CODEX_APP_SERVER_WS_URL ?? null,
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
        codexAppServerVersion: t.String(),
        codexBin: t.String(),
        codexAppServerWsUrl: t.Union([t.String(), t.Null()]),
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
