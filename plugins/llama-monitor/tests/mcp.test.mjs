import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('MCP protocol and every declared tool return one bounded result',()=>{
 const messages=[
  {id:1,method:'initialize'},
  {method:'notifications/initialized'},
  {id:2,method:'tools/list'},
  {id:3,method:'tools/call',params:{name:'parse_snapshot',arguments:{snapshot:{at:'2026-11-16T00:00:00Z'}}}},
  {id:4,method:'tools/call',params:{name:'summarize_session',arguments:{samples:[]}}},
  {id:5,method:'tools/call',params:{name:'read_engine',arguments:{url:'https://engine.example.com',connection:'engine_api'}}}
 ];
 const r=spawnSync(process.execPath,['server.mjs'],{input:messages.map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n',encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr);const replies=r.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(replies.map(x=>x.id),[1,2,3,4,5]);
 assert.equal(replies[1].result.tools.length,5);
 assert.equal(replies[2].result.isError,undefined);
 assert.equal(replies[3].result.isError,undefined);
 assert.equal(replies[4].result.isError,true);
 assert.match(replies[4].result.content[0].text,/Approve connections:read/);
});
test('browser module parses without executing host-dependent code',()=>{
 const r=spawnSync(process.execPath,['--check','ui/app.js'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
