import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateProfile,validateRunSettings} from '../lib/profile.mjs';
import {PROFILE} from './fixture.mjs';
test('saved target defaults are reusable and each run has an independent snapshot',()=>{
 const profile=validateProfile({...structuredClone(PROFILE),targetVersions:{svc:'1.1.0'}});
 const run=validateRunSettings({profileId:profile.id},profile);
 profile.targetVersions.svc='1.2.0';
 assert.deepEqual(run.versions,{svc:'1.1.0'});
 assert.deepEqual(validateRunSettings({profileId:profile.id,versions:{svc:'1.3.0'}},profile).versions,{svc:'1.3.0'});
});
test('defaults reject unknown products and invalid versions',()=>{
 for(const targetVersions of [{unknown:'1.0.0'},{svc:'bad version'},null,[]])assert.throws(()=>validateProfile({...structuredClone(PROFILE),targetVersions}));
});
