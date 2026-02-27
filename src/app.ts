import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";

import { bridgeRuntime as runtime } from "./modules/bridge/service";
import { codexModule } from "./modules/codex";
import { debugModule } from "./modules/debug";
import { healthModule } from "./modules/health";
import { lanesModule } from "./modules/lanes";
import { watchModule } from "./modules/watch";
import { webhooksModule } from "./modules/webhooks";

export function createApp() {
  return new Elysia({
    name: "codex-bridge",
    serve: {
      idleTimeout: 60,
    },
  })
    .onRequest(({ request }) => {
      const url = new URL(request.url);
      runtime.debugLog("request", {
        method: request.method.toUpperCase(),
        path: url.pathname,
      });
    })
    .onError(({ code, error, status }) => {
      if (code === "VALIDATION") {
        return status(400, {
          error: "validation_error",
          message: error.message,
        });
      }
      return undefined;
    })
    .use(
      openapi({
        path: "/openapi",
        documentation: {
          info: {
            title: "Codex Bridge API",
            version: runtime.APP_VERSION,
            description:
              "Bridge API for lane/session orchestration, Codex thread control, and webhook subscriptions.",
          },
          tags: [
            { name: "health" },
            { name: "events" },
            { name: "watch" },
            { name: "webhooks" },
            { name: "codex" },
            { name: "turns" },
            { name: "lanes" },
            { name: "approvals" },
            { name: "debug" },
          ],
        },
      })
    )
    .use(healthModule)
    .use(watchModule)
    .use(webhooksModule)
    .use(codexModule)
    .use(lanesModule)
    .use(debugModule)
    .all("*", ({ status }) => status(404, { error: "not_found" }), {
      detail: {
        hide: true,
      },
    });
}
