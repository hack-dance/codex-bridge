import { spawn } from 'node:child_process';
import readline from 'node:readline';

const threadId = process.argv[2];
if (!threadId) throw new Error('threadId required');

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map<number, (m:any)=>void>();
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const req=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const rid=id++; pending.set(rid,resolve); send({id:rid,method,params}); setTimeout(()=>reject(new Error('timeout:'+method)),12000);});
rl.on('line',line=>{try{const m=JSON.parse(line); if(typeof m.id==='number'){const cb=pending.get(m.id); if(cb){pending.delete(m.id); cb(m)}} else {console.log('NOTIFY',JSON.stringify(m));}}catch{}});

(async()=>{
  const init=await req('initialize',{clientInfo:{name:'probe-resume',title:'probe-resume',version:'0.1'}});
  send({method:'initialized',params:{}});
  console.log('INIT', JSON.stringify(init));
  const resume=await req('thread/resume',{threadId});
  console.log('RESUME', JSON.stringify(resume));
  const read=await req('thread/read',{threadId});
  console.log('READ', JSON.stringify(read));
  proc.kill('SIGTERM');
})();
