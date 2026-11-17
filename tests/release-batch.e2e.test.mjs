import './octipus.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,existsSync,readdirSync,cpSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {makeMarket} from './market.mjs';
import {build} from '../scripts/build.mjs';
import {publishBuild} from '../scripts/publish.mjs';
import {sign} from '../scripts/sign.mjs';
const quiet=()=>{};
async function prepared(dir,two=false){
 const m=await makeMarket(dir);
 if(two){const target=join(m.repo,'plugins/second-reader');cpSync(join(m.repo,'plugins/reader'),target,{recursive:true});const p=join(target,'octipus-plugin.json'),manifest=JSON.parse(readFileSync(p,'utf8'));manifest.name='second-reader';writeFileSync(p,JSON.stringify(manifest));m.g('add','.');m.g('commit','-qm','Add second package');m.g('push','-q','origin','main');}
 const record=await build(m.repo,join(dir,'ci'));m.serveRecord(record);
 const plan=await publishBuild({root:m.repo,out:join(dir,'release'),keysFrom:m.keysFile,gh:m.gh,log:quiet,noPreviousIndex:true});
 return {m,plan,opts:{repo:m.repo,planFile:plan.planFile,key:m.signingKey,rootPubs:[m.rootPub],passphraseFile:m.passFile,keysFrom:m.keysFile,gh:m.gh,noPreviousIndex:true,batch:true,yes:false,log:quiet}};
}
test('batch review can cancel without signing, then approve packages and index once on retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-batch-'));
 try {const {opts,plan}=await prepared(dir);let approvals=0;
  await assert.rejects(sign({...opts,confirmBatch:async()=>{approvals++;return false;}}),/cancelled/);
  assert.equal(approvals,1);assert.equal(existsSync(join(dirname(plan.planFile),'signed/index.json.sig')),false);
  const result=await sign({...opts,retry:true,confirmBatch:async()=>{approvals++;return true;}});
  assert.equal(approvals,2);assert.equal(result.records.length,1);assert.ok(existsSync(join(result.out,'index.json.sig')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a later package failing validation prevents every signature and the batch approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-invalid-batch-'));
 try {const {opts,plan}=await prepared(dir,true);const document=JSON.parse(readFileSync(plan.planFile,'utf8'));assert.equal(document.packages.length,2);
  writeFileSync(join(dirname(plan.planFile),document.packages[1].tarball),'invalid bytes');let asked=false;
  await assert.rejects(sign({...opts,confirmBatch:async()=>{asked=true;return true;}}),/not the tarball/);
  assert.equal(asked,false);const dl=join(dirname(plan.planFile),'signed/dl');assert.equal(existsSync(dl)?readdirSync(dl).length:0,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
