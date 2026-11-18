import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readEngine,hostRequest} from '../transport.mjs';
test('live reader uses fixed read paths through named connection; partial failures explicit',async()=>{
 const requests=[];
 const out=await readEngine({url:'https://engine.example.com',connection:'engine_api'},null,async(_h,path,input)=>{
  requests.push([path,input]);
  if(input.path==='/metrics')return {ok:false,status:501};
  return {ok:true,status:200,body:{data:[{id:'Example model'}]}};
 });
 assert.equal(requests.length,4);
 assert.ok(requests.every(([p,i])=>p==='/connections/get' && i.connection==='engine_api' && i.expectedOrigin==='https://engine.example.com'));
 assert.ok(out.warnings.some(x=>x.includes('501')));assert.equal(out.metrics,undefined);
});
test('all probes failed is an error, never a successful snapshot',async()=>{
 await assert.rejects(()=>readEngine({url:'https://engine.example.com',connection:'engine_api'},null,async()=>{throw new Error('Denied');}),/Denied/);
});
test('host collector stale telemetry withheld',async()=>{
 const out=await readEngine({url:'https://engine.example.com',connection:'engine_api',telemetryConnection:'collector'},null,async(_h,_p,i)=>{
  return i.connection==='collector'?{ok:true,body:{at:'2020-01-01T00:00:00Z',host:{cpuPercent:1}}}:{ok:true,body:{}};
 });
 assert.equal(out.host,undefined);assert.ok(out.warnings.some(x=>x.includes('stale')));
});
test('transport requires approved short-lived host capability',()=>{
 assert.throws(()=>hostRequest(null,'/connections/get',{}),/Approve connections:read/);
});
