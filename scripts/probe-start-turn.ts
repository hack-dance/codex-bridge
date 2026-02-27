import { spawn } from "node:child_process";
import readline from "node:readline";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "ignore"],
});
const rl = readline.createInterface({ input: proc.stdout });
let seq = 1;
const pending = new Map<number, (message: RpcMessage) => void>();

const send = (payload: Record<string, unknown>) =>
  proc.stdin.write(`${JSON.stringify(payload)}\n`);

const request = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<RpcMessage>((resolve, reject) => {
    const id = seq++;
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => reject(new Error(`timeout ${method}`)), 12_000);
  });

rl.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RpcMessage;
    if (typeof message.id === "number" && !message.method) {
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
  await request("initialize", {
    clientInfo: { name: "probe", title: "probe", version: "0.1" },
  });
  send({ method: "initialized", params: {} });
  const startThread = await request("thread/start", {});
  const startedThread = startThread.result?.thread;
  const threadId =
    startedThread && typeof startedThread === "object"
      ? ((startedThread as Record<string, unknown>).id ?? null)
      : null;
  const startTurn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "say ok" }],
  });
  console.log(JSON.stringify({ threadId, startThread, startTurn }, null, 2));
  proc.kill("SIGTERM");
})();
