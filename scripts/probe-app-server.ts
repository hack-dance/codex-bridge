import { spawn } from 'node:child_process';
import readline from 'node:readline';

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: proc.stdout });

let id = 1;
const pending = new Map<number, (msg: any) => void>();
const notifications: any[] = [];

function send(method: string, params: any = {}) {
  const reqId = id++;
  const payload = { id: reqId, method, params };
  proc.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise<any>((resolve) => pending.set(reqId, resolve));
}

rl.on('line', (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.id === 'number') {
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  } else {
    notifications.push(msg);
  }
});

proc.stderr.on('data', (d) => {
  // keep quiet unless needed
});

async function call(method: string, params: any = {}) {
  const res = await send(method, params);
  if (res.error) return { ok: false, method, error: res.error };
  return { ok: true, method, result: res.result };
}

async function main() {
  const out: any = { calls: [] };

  out.calls.push(await call('initialize', {
    clientInfo: { name: 'oai_app_proxy_probe', title: 'oai-app-proxy probe', version: '0.1.0' }
  }));

  proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');

  const methodsToTry = [
    ['thread/loaded/list', {}],
    ['thread/list', { limit: 20 }],
    ['thread/list', {}],
    ['listConversations', { limit: 20 }],
    ['listConversations', {}],
    ['app/list', {}],
    ['skills/list', {}],
  ] as const;

  for (const [m, p] of methodsToTry) {
    out.calls.push(await call(m, p));
  }

  // brief notification sample
  await new Promise((r) => setTimeout(r, 300));
  out.notificationCount = notifications.length;
  out.notificationsSample = notifications.slice(0, 5);

  console.log(JSON.stringify(out, null, 2));
  proc.kill('SIGTERM');
}

main().catch((err) => {
  console.error(err);
  proc.kill('SIGTERM');
  process.exit(1);
});
