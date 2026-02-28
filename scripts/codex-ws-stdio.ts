import readline from "node:readline";

const wsUrl = process.argv[2];
if (!wsUrl) {
  process.stderr.write(
    "codex-ws-stdio:missing ws URL. Pass CODEX_APP_SERVER_WS_URL.\n"
  );
  process.exit(1);
}

const CONNECT_TIMEOUT_MS = 5000;
const textDecoder = new TextDecoder();
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
const queue: string[] = [];

let isOpen = false;
let isShuttingDown = false;
const ws = new WebSocket(wsUrl);

const connectTimeout = setTimeout(() => {
  if (isOpen || isShuttingDown) {
    return;
  }
  process.stderr.write(`codex-ws-stdio:connect timeout for ${wsUrl}\n`);
  shutdown({ exitCode: 1 });
}, CONNECT_TIMEOUT_MS);
connectTimeout.unref();

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function flushQueue() {
  while (isOpen && queue.length > 0) {
    const line = queue.shift();
    if (typeof line === "string") {
      ws.send(line);
    }
  }
}

async function messageDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(data);
  }
  if (isBlobLike(data)) {
    return await data.text();
  }
  return JSON.stringify(data);
}

function writeOutputLine(line: string) {
  if (line.endsWith("\n")) {
    process.stdout.write(line);
    return;
  }
  process.stdout.write(`${line}\n`);
}

function shutdown({ exitCode }: { exitCode: number }) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  clearTimeout(connectTimeout);
  try {
    input.close();
  } catch {
    // ignore close errors
  }
  try {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  } catch {
    // ignore close errors
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 0).unref();
}

input.on("line", (line) => {
  if (isShuttingDown) {
    return;
  }
  if (isOpen) {
    ws.send(line);
    return;
  }
  queue.push(line);
});

input.on("close", () => {
  shutdown({ exitCode: 0 });
});

process.on("SIGINT", () => {
  shutdown({ exitCode: 0 });
});

process.on("SIGTERM", () => {
  shutdown({ exitCode: 0 });
});

ws.addEventListener("open", () => {
  isOpen = true;
  clearTimeout(connectTimeout);
  flushQueue();
});

ws.addEventListener("message", (event) => {
  messageDataToText(event.data)
    .then((line) => {
      writeOutputLine(line);
    })
    .catch((error) => {
      process.stderr.write(
        `codex-ws-stdio:message parse failed: ${String(error)}\n`
      );
    });
});

ws.addEventListener("error", () => {
  if (!isShuttingDown) {
    process.stderr.write("codex-ws-stdio:websocket error\n");
  }
});

ws.addEventListener("close", (event) => {
  isOpen = false;
  if (isShuttingDown) {
    return;
  }
  const exitCode = event.wasClean ? 0 : 1;
  process.stderr.write(
    `codex-ws-stdio:websocket closed code=${event.code} clean=${String(event.wasClean)}\n`
  );
  shutdown({ exitCode });
});
