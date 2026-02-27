import { Elysia, t } from "elysia";

import { bridgeRuntime as runtime } from "../bridge/service";

const watchStartBody = t.Object({
  intervalSec: t.Optional(t.Numeric()),
});

const watchStateResponse = t.Object({
  running: t.Boolean(),
  intervalSec: t.Number(),
});

export const watchModule = new Elysia({ name: "watch-module" })
  .get("/watch/status", () => runtime.getWatcherState(), {
    detail: {
      summary: "Get watcher status",
      tags: ["watch"],
    },
    response: watchStateResponse,
  })
  .post(
    "/watch/start",
    ({ body }) => {
      runtime.startWatcher(Number(body.intervalSec ?? 15));
      return runtime.getWatcherState();
    },
    {
      detail: {
        summary: "Start watcher",
        tags: ["watch"],
      },
      body: watchStartBody,
      response: watchStateResponse,
    }
  )
  .post(
    "/watch/stop",
    () => {
      runtime.stopWatcher();
      return runtime.getWatcherState();
    },
    {
      detail: {
        summary: "Stop watcher",
        tags: ["watch"],
      },
      response: watchStateResponse,
    }
  )
  .post(
    "/watch/tick",
    async () => {
      await runtime.runWatcherTick();
      return { ok: true };
    },
    {
      detail: {
        summary: "Run a watcher tick",
        tags: ["watch"],
      },
      response: t.Object({
        ok: t.Boolean(),
      }),
    }
  );
