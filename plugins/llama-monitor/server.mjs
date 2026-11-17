import { createInterface } from 'node:readline';
import { normalize, summarize } from './ui/metrics.mjs';
import { readEngine } from './transport.mjs';
const NAME = 'llama-monitor';
const tools = [
 { name:'read_engine', description:'Read llama.cpp telemetry through exact admin-approved connection paths. No inference or model changes.', inputSchema:{type:'object',properties:{connection:{type:'string'},url:{type:'string'},engineId:{type:'string'},telemetryConnection:{type:'string'}},required:['connection','url']} },
 { name:'parse_snapshot', description:'Normalize a supplied llama.cpp/host snapshot. No network access.', inputSchema:{type:'object',properties:{snapshot:{type:'object'},previous:{type:'object'}},required:['snapshot']} },
 { name:'summarize_session', description:'Calculate low, peak and average for supplied telemetry samples.', inputSchema:{type:'object',properties:{samples:{type:'array',maxItems:5000,items:{type:'object'}}},required:['samples']} }
];
const text = (value, isError=false) => ({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],...(isError?{isError:true}:{})});
async function handle(msg) {
 switch(msg.method) {
  case 'initialize':return {protocolVersion:msg.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:NAME,version:'0.2.3'}};
  case 'ping':case 'shutdown':return {};
  case 'tools/list':return {tools};
  case 'tools/call':
   try {
    const a=msg.params.arguments || {};
    if(msg.params.name==='read_engine') return text(await readEngine(a,msg.params?._meta?.['octipus/host']));
    if(msg.params.name==='parse_snapshot') return text(normalize(a.snapshot,a.previous));
    if(msg.params.name==='summarize_session') return text(summarize(a.samples));
    return text('Unknown tool',true);
   } catch(e) {return text(e.message,true);}
  default:throw Object.assign(new Error('Method not found'),{code:-32601});
 }
}
createInterface({input:process.stdin}).on('line',async line=>{
 let msg;try{msg=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');return;}
 if(msg.id===undefined || msg.id===null)return;
 let reply;try{reply={result:await handle(msg)};}catch(e){reply={error:{code:e.code || -32603,message:e.message}};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,...reply})+'\n');
});
