import { spawn } from 'node:child_process';
import readline from 'node:readline';

const threadId = process.argv[2];
if (!threadId) throw new Error('threadId required');

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const rl = readline.createInterface({ input: proc.stdout });
let seq=1;
const pending = new Map<number,(m:any)=>void>();
const notes:any[]=[];
const send=(p:any)=>proc.stdin.write(JSON.stringify(p)+'\n');
const request=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=seq++; pending.set(id,resolve); send({id,method,params}); setTimeout(()=>reject(new Error('timeout '+method)),10000)});
rl.on('line',line=>{try{const m=JSON.parse(line); if(typeof m.id==='number'){const cb=pending.get(m.id); if(cb){pending.delete(m.id); cb(m)}} else notes.push(m)}catch{}});

(async()=>{
 const out:any={};
 out.init=await request('initialize',{clientInfo:{name:'probe-batch',title:'probe-batch',version:'0.1'}}); send({method:'initialized',params:{}});
 out.resume=await request('thread/resume',{threadId});
 out.turn=await request('turn/start',{threadId,input:[{type:'text',text:'say OK only'}]});
 await new Promise(r=>setTimeout(r,3000));
 out.notifications=notes.slice(0,8);
 console.log(JSON.stringify(out,null,2));
 proc.kill('SIGTERM');
})();
