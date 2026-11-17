import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isPublicationCommit,runRelease,artifactHashes,verifyArtifacts,writeState,validateConfig} from './release.mjs';
const phases=['prepare','sign','finish','deploy','record','verify'];
function operations(events) {return {verifyCompleted:async p=>events.push('verify:'+p),reconcile:async()=>false,...Object.fromEntries(phases.map(p=>[p,async()=>events.push(p)]))};}
test('lost publication response is inspected, then reconciled without a second deployment or signing',async()=>{
 const events=[],state={completed:['prepare','sign','finish'],active:'deploy'};
 const ops=operations(events);ops.reconcile=async p=>{events.push('inspect:'+p);return p==='deploy';};
 await runRelease(state,ops,async()=>{});
 assert.deepEqual(events,['verify:prepare','verify:sign','verify:finish','inspect:deploy','record','verify']);
 assert.deepEqual(state.completed,phases);
});
test('failure keeps a durable stage and resumes only remaining work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-recovery-'));
 try {
  const path=join(dir,'release.json'),events=[],state={completed:[],active:null};
  const ops=operations(events);ops.sign=async()=>{throw Error('Wrong passphrase');};
  await assert.rejects(runRelease(state,ops,s=>writeState(path,s)),/Wrong passphrase/);
  const saved=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(saved.completed,['prepare']);assert.equal(saved.active,'sign');
  await runRelease(saved,operations(events),s=>writeState(path,s));
  assert.equal(events.filter(p=>p==='prepare').length,1);assert.ok(JSON.parse(readFileSync(path,'utf8')).finishedAt);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('edited release output is refused before deployment',()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-artifacts-'));
 try {writeFileSync(join(dir,'index.json'),'signed bytes');const hashes=artifactHashes(dir);verifyArtifacts(dir,hashes);writeFileSync(join(dir,'index.json'),'changed');assert.throws(()=>verifyArtifacts(dir,hashes),/changed/);}
 finally {rmSync(dir,{recursive:true,force:true});}
});
test('publisher destination cannot inject a remote shell or target filesystem root',()=>{
 const base={schema:1,rootPub:'/private/root.pub',key:'/private/signing.key'};
 assert.throws(()=>validateConfig({...base,deploy:{host:'host;bad',directory:'/var/www/site',publicUrl:'https://example.com'}}));
 assert.throws(()=>validateConfig({...base,deploy:{host:'host',directory:'/',publicUrl:'https://example.com'}}));
 assert.throws(()=>validateConfig({...base,deploy:{host:'host',directory:'/var/www/../site',publicUrl:'https://example.com'}}));
 assert.equal(validateConfig({...base,deploy:{host:'user@host',directory:'/var/www/site',publicUrl:'https://example.com'}}).schema,1);
});
test('an unreachable verification target cannot turn an unknown deployment into a replay',async()=>{
 const state={completed:['prepare','sign','finish'],active:'deploy'},events=[];
 const ops=operations(events);ops.reconcile=async()=>{throw Error('Target unreachable');};
 await assert.rejects(runRelease(state,ops,async()=>{}),/Target unreachable/);
 assert.equal(state.active,'deploy');assert.equal(state.error.phase,'deploy');assert.equal(events.includes('deploy'),false);
});

test('an unjournaled publication commit is recognized only with the reviewed parent, single path and exact record',async()=>{
 const {createHash}=await import('node:crypto');
 const bytes=Buffer.from('{"released":true}'), state={commit:'a'.repeat(40),publishedHash:createHash('sha256').update(bytes).digest('hex')};
 assert.equal(isPublicationCommit(state,state.commit,'published.json',bytes),true);
 assert.equal(isPublicationCommit(state,'b'.repeat(40),'published.json',bytes),false);
 assert.equal(isPublicationCommit(state,state.commit,'published.json\nother.js',bytes),false);
 assert.equal(isPublicationCommit(state,state.commit,'published.json',Buffer.from('different')),false);
});
