import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prometheus,normalize,summarize,profile} from '../ui/metrics.mjs';
const metrics=(p,s,o,t)=>[
 'llamacpp:prompt_tokens_total '+p,'llamacpp:prompt_seconds_total '+s,
 'llamacpp:tokens_predicted_total '+o,'llamacpp:tokens_predicted_seconds_total '+t
].join('\n');
test('counter deltas produce active rates, idle values stay unavailable',()=>{
 const a=normalize({at:'2026-11-16T00:00:00Z',metrics:metrics(100,2,10,1)});
 assert.equal(a.values.prefillTps,null);
 const b=normalize({at:'2026-11-16T00:00:10Z',metrics:metrics(300,3,60,3)},a);
 assert.equal(b.values.prefillTps,200);assert.equal(b.values.outputTps,25);
 const idle=normalize({at:'2026-11-16T00:00:20Z',metrics:metrics(300,3,60,3)},b);
 assert.equal(idle.values.outputTps,null);
});
test('reset, missing telemetry and advertised models remain honest',()=>{
 const a=normalize({at:'2026-11-16T00:00:00Z',metrics:metrics(100,2,10,1)});
 const b=normalize({at:'2026-11-16T00:00:10Z',metrics:metrics(1,1,1,1),models:{data:[{id:'Example model'}]}},a);
 assert.equal(b.reset,true);assert.equal(b.values.prefillTps,null);assert.equal(b.values.ramAvailableBytes,null);
 assert.equal(b.models[0].state,'advertised');assert.ok(b.warnings.length);
});
test('summary skips null, nonfinite and negative values; valid zero remains',()=>{
 const out=summarize([0,2,null,Infinity,-2].map((n,i)=>({at:new Date(1000*i).toISOString(),values:{cpuPercent:n}})));
 assert.deepEqual(out.metrics.cpuPercent,{label:'CPU usage',unit:'%',count:2,low:0,peak:2,average:1});
 assert.equal(out.metrics.outputTps.average,null);
});
test('profile accepts engine URL but rejects credentials and non-http',()=>{
 assert.equal(profile({name:'Example engine',url:'https://engine.example.com',connection:'engine_api'}).connection,'engine_api');
 for(const url of ['file:///x','http://user:secret@example.org','http://a/?token=x'])assert.throws(()=>profile({name:'x',url}));
});
test('prometheus ignores comments and nonfinite values, accepts labels',()=>{
 const m=prometheus('# HELP foo\nllamacpp:requests_processing{model="a"} 2\nllamacpp:requests_processing{model="b"} 1\nx NaN');
 assert.equal(m['llamacpp:requests_processing'],3);assert.equal(m.x,undefined);
 assert.throws(()=>normalize({at:'bad'}));assert.throws(()=>summarize(Array(5001)));
});
