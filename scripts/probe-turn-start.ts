import { spawn } from 'node:child_process';
import readline from 'node:readline';

const threadId = process.argv[2];
if (!threadId) throw new Error('threadId required');

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map<number, (m:any)=>void>();

const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const req=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{
  const rid=id++; pending.set(rid,resolve); send({id:rid,method,params}); setTimeout(()=>reject(new Error('timeout:'+method)),12000);
});

rl.on('line',line=>{try{const m=JSON.parse(line); if(typeof m.id==='number'){const cb=pending.get(m.id); if(cb){pending.delete(m.id);cb(m)}} else { console.log('NOTIFY', JSON.stringify(m)); }}catch{}});

(async()=>{
  const init=await req('initialize',{clientInfo:{name:'probe-turn',title:'probe-turn',version:'0.1'}});
  if(init.error) throw new Error(init.error.message);
  send({method:'initialized',params:{}});
  const res=await req('turn/start',{threadId,input:[{type:'text',text:'Reply with exactly OK'}]});
  console.log('TURN_START_RES', JSON.stringify(res));
  await new Promise(r=>setTimeout(r,8000));
  proc.kill('SIGTERM');
})();
