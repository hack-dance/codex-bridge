import { createApp } from "./src/app";
import { initializeBridgeRuntime } from "./src/modules/bridge/service";

await initializeBridgeRuntime();

const cliPortArgIndex = process.argv.indexOf("--port");
const cliPort =
  cliPortArgIndex >= 0 ? Number(process.argv[cliPortArgIndex + 1]) : Number.NaN;
const bindPort = Number.isFinite(cliPort)
  ? cliPort
  : Number(process.env.PORT ?? 8787);

const app = createApp();
app.listen(bindPort);
const boundPort = app.server?.port ?? bindPort;

console.log(`oai-app-proxy v0.5 listening on http://localhost:${boundPort}`);
