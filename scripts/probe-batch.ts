import { spawn } from "node:child_process";
import readline from "node:readline";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface BatchProbeResult {
  init?: RpcMessage;
  resume?: RpcMessage;
  turn?: RpcMessage;
  notifications: RpcMessage[];
}

const threadId = process.argv[2];
if (!threadId) {
  throw new Error("threadId required");
}

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "ignore"],
});
const rl = readline.createInterface({ input: proc.stdout });
let seq = 1;
const pending = new Map<number, (message: RpcMessage) => void>();
const notifications: RpcMessage[] = [];

const send = (payload: Record<string, unknown>) => {
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
};

const request = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<RpcMessage>((resolve, reject) => {
    const id = seq++;
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000);
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
    } else {
      notifications.push(message);
    }
  } catch {
    // ignore parse errors from non-JSON lines
  }
});

(async () => {
  const out: BatchProbeResult = { notifications: [] };
  out.init = await request("initialize", {
    clientInfo: { name: "probe-batch", title: "probe-batch", version: "0.1" },
  });
  send({ method: "initialized", params: {} });
  out.resume = await request("thread/resume", { threadId });
  out.turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "say OK only" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  out.notifications = notifications.slice(0, 8);
  console.log(JSON.stringify(out, null, 2));
  proc.kill("SIGTERM");
})();
