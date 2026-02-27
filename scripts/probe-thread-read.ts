import { spawn } from "node:child_process";
import readline from "node:readline";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

const threadId = process.argv[2];
if (!threadId) {
  throw new Error("threadId required");
}

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "ignore"],
});
const rl = readline.createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map<number, (message: RpcMessage) => void>();

const send = (message: Record<string, unknown>) => {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
};

const request = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<RpcMessage>((resolve, reject) => {
    const requestId = id++;
    pending.set(requestId, resolve);
    send({ id: requestId, method, params });
    setTimeout(() => reject(new Error("timeout")), 8000);
  });

rl.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RpcMessage;
    if (typeof message.id === "number") {
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    }
  } catch {
    // ignore parse errors from non-JSON lines
  }
});

(async () => {
  const init = await request("initialize", {
    clientInfo: { name: "probe", title: "probe", version: "0.1" },
  });
  if (init.error) {
    throw new Error(init.error.message);
  }
  send({ method: "initialized", params: {} });
  const response = await request("thread/read", { threadId });
  console.log(JSON.stringify(response, null, 2));
  proc.kill("SIGTERM");
})().catch((error: unknown) => {
  console.error(String(error));
  proc.kill("SIGTERM");
  process.exit(1);
});
