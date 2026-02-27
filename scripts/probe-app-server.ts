import { spawn } from "node:child_process";
import readline from "node:readline";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface ProbeCallResult {
  ok: boolean;
  method: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface ProbeOutput {
  calls: ProbeCallResult[];
  notificationCount: number;
  notificationsSample: RpcMessage[];
}

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const rl = readline.createInterface({ input: proc.stdout });

let id = 1;
const pending = new Map<number, (message: RpcMessage) => void>();
const notifications: RpcMessage[] = [];

function send(method: string, params: Record<string, unknown> = {}) {
  const requestId = id++;
  const payload = { id: requestId, method, params };
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise<RpcMessage>((resolve) => pending.set(requestId, resolve));
}

rl.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RpcMessage;
    if (typeof message.id === "number") {
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    } else {
      notifications.push(message);
    }
  } catch {
    // ignore parse errors from non-JSON lines
  }
});

proc.stderr.on("data", () => {
  // keep quiet unless needed
});

async function call(
  method: string,
  params: Record<string, unknown> = {}
): Promise<ProbeCallResult> {
  const response = await send(method, params);
  if (response.error) {
    return { ok: false, method, error: response.error };
  }
  return { ok: true, method, result: response.result };
}

async function main() {
  const out: ProbeOutput = {
    calls: [],
    notificationCount: 0,
    notificationsSample: [],
  };

  out.calls.push(
    await call("initialize", {
      clientInfo: {
        name: "oai_app_proxy_probe",
        title: "oai-app-proxy probe",
        version: "0.1.0",
      },
    })
  );

  proc.stdin.write(
    `${JSON.stringify({ method: "initialized", params: {} })}\n`
  );

  const methodsToTry = [
    ["thread/loaded/list", {}],
    ["thread/list", { limit: 20 }],
    ["thread/list", {}],
    ["listConversations", { limit: 20 }],
    ["listConversations", {}],
    ["app/list", {}],
    ["skills/list", {}],
  ] as const;

  for (const [method, params] of methodsToTry) {
    out.calls.push(await call(method, params));
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  out.notificationCount = notifications.length;
  out.notificationsSample = notifications.slice(0, 5);

  console.log(JSON.stringify(out, null, 2));
  proc.kill("SIGTERM");
}

main().catch((error: unknown) => {
  console.error(error);
  proc.kill("SIGTERM");
  process.exit(1);
});
