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
  stdio: ["pipe", "pipe", "inherit"],
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
    setTimeout(() => reject(new Error(`timeout:${method}`)), 12_000);
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
      console.log("NOTIFY", JSON.stringify(message));
    }
  } catch {
    // ignore parse errors from non-JSON lines
  }
});

(async () => {
  const init = await request("initialize", {
    clientInfo: { name: "probe-turn", title: "probe-turn", version: "0.1" },
  });
  if (init.error) {
    throw new Error(init.error.message);
  }
  send({ method: "initialized", params: {} });
  const response = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly OK" }],
  });
  console.log("TURN_START_RES", JSON.stringify(response));
  await new Promise((resolve) => setTimeout(resolve, 8000));
  proc.kill("SIGTERM");
})();
