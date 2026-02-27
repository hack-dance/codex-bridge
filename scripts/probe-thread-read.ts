import { spawn } from 'node:child_process';
import readline from 'node:readline';

const threadId = process.argv[2];
if (!threadId) throw new Error('threadId required');

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const rl = readline.createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map<number, (m:any)=>void>();
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const req=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const rid=id++;pending.set(rid,resolve);send({id:rid,method,params});setTimeout(()=>reject(new Error('timeout')),8000)});
rl.on('line',line=>{try{const m=JSON.parse(line);if(typeof m.id==='number'){const cb=pending.get(m.id); if(cb){pending.delete(m.id);cb(m)}}}catch{}});

(async()=>{
  const init=await req('initialize',{clientInfo:{name:'probe',title:'probe',version:'0.1'}});
  if(init.error) throw new Error(init.error.message);
  send({method:'initialized',params:{}});
  const res=await req('thread/read',{threadId});
  console.log(JSON.stringify(res,null,2));
  proc.kill('SIGTERM');
})().catch(e=>{console.error(String(e));proc.kill('SIGTERM');process.exit(1)});
