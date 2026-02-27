import { spawn } from 'node:child_process';
import readline from 'node:readline';
const proc=spawn('codex',['app-server'],{stdio:['pipe','pipe','ignore']});
const rl=readline.createInterface({input:proc.stdout});
let seq=1;const pending=new Map<number,(m:any)=>void>();
const send=(p:any)=>proc.stdin.write(JSON.stringify(p)+'\n');
const req=(m:string,p:any={})=>new Promise<any>((resolve,reject)=>{const id=seq++;pending.set(id,resolve);send({id,method:m,params:p});setTimeout(()=>reject(new Error('timeout '+m)),12000)});
rl.on('line',line=>{try{const m=JSON.parse(line); if(typeof m.id==='number'&&!m.method){const cb=pending.get(m.id); if(cb){pending.delete(m.id);cb(m)}}}catch{}});
(async()=>{const init=await req('initialize',{clientInfo:{name:'probe',title:'probe',version:'0.1'}});send({method:'initialized',params:{}}); const st=await req('thread/start',{}); const tid=st.result?.thread?.id; const t=await req('turn/start',{threadId:tid,input:[{type:'text',text:'say ok'}]}); console.log(JSON.stringify({tid,st,t},null,2)); proc.kill('SIGTERM');})();
