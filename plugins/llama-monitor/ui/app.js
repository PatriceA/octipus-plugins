import { profile, normalize, summarize, FIELDS } from './metrics.mjs';
const $=id=>document.getElementById(id);
const engineFields=new Set(['prefillTps','outputTps','requestsProcessing','requestsDeferred','contextHighWater','latencyMs']);
function hostState(hasHost=false){
 $('host-cards').hidden=!hasHost;
 $('host-status').textContent=hasHost?'Host collector connected. Only supplied readings appear.':selected?.telemetryConnection?'Collector has not returned host readings. Read once, then check its service, connection and path grant if this persists.':'Collector not configured. Engine metrics work independently.';
}
const params=new URLSearchParams(location.hash.slice(1)), waiting=new Map();
let ready=false;
let port=null, next=1, profiles=[], profilesVersion=0, selected=null, editingId=null, previous=null, latest=null, session=null, busy=false, timer=null;
if(params.get('octipus') && params.get('parent')){
 const channel=new MessageChannel();port=channel.port1;
 port.onmessage=e=>{
  const m=e.data;
  if(m?.octipus==='theme'){
   for(const [key,value] of Object.entries(m.tokens || {})){
    if(/^--(?:color-|font-|radius)/.test(key) && typeof value==='string')document.documentElement.style.setProperty(key,value);
   }
   if(m.colorScheme==='dark'||m.colorScheme==='light')document.documentElement.style.colorScheme=m.colorScheme;
   if(typeof m.fontFamily==='string')document.documentElement.style.fontFamily=m.fontFamily;
  }
  if(m?.octipus==='result' && waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}
 };
 parent.postMessage({octipus:'ready',nonce:params.get('octipus')},params.get('parent'),[channel.port2]);
}
function bridge(message){
 return new Promise((resolve,reject)=>{
  if(!port)return reject(new Error('Open this page inside Octipus.'));
  const id=next++, timeout=setTimeout(()=>{waiting.delete(id);reject(new Error('Octipus bridge timed out.'));},30000);
  waiting.set(id,m=>{clearTimeout(timeout);m.ok?resolve(m.result):reject(Object.assign(new Error(m.error || m.code || 'Bridge call failed'),{code:m.code || 'failed'}));});
  port.postMessage({...message,id});
 });
}
// Pace history reads below the bridge's per-user request limit.
let storeQueue=Promise.resolve(), nextStoreAt=0;
function store(op,fields){
 const result=storeQueue.then(()=>new Promise(resolve=>setTimeout(resolve,Math.max(0,nextStoreAt-Date.now())))).then(()=>{
  nextStoreAt=Date.now()+125;return bridge({octipus:'store',op,...fields});
 });
 storeQueue=result.catch(()=>{});return result;
}
async function get(key){try{return await store('store.get',{key});}catch(e){if(e.code==='not_found')return null;throw e;}}
const set=(key,value,ifVersion)=>store('store.set',{key,value,...(ifVersion===undefined?{}:{ifVersion})});
async function call(tool,args){
 const out=await bridge({octipus:'call',tool,args});
 const text=out.content?.find(x=>x.type==='text')?.text;
 if(out.isError)throw new Error(text || 'Plugin tool failed.');
 return out.structuredContent || JSON.parse(text);
}
function error(e){$('error').hidden=!e;$('error').textContent=e?.message || '';}
function updateControls(){
 const locked=busy || !ready, active=!!session;
 $('save').disabled=locked || active;
 $('edit').disabled=locked || !selected || active;
 $('cancel-edit').disabled=locked || active;
 for(const id of ['name','url','connection','telemetry-connection'])$(id).disabled=locked || active;
 $('save-collector').disabled=locked || !selected || active;
 $('start').disabled=locked || !selected || active;
 $('stop').disabled=busy || !active;
 $('refresh').disabled=locked || !selected;
 $('remove').disabled=locked || !selected || active;
 $('engines').disabled=busy || active;
 $('interval').disabled=busy || active;
 $('view').disabled=locked || active || !$('history').value;
 $('delete-session').disabled=locked || active || !$('history').value;
 $('import').disabled=locked || !selected;
 $('retry-load').disabled=busy;
}
async function run(fn){
 if(busy)return;
 busy=true;updateControls();error(null);document.querySelector('main').setAttribute('aria-busy','true');
 try{await fn();}catch(e){error(e);}finally{busy=false;updateControls();document.querySelector('main').setAttribute('aria-busy','false');}
}
function resetEditor(){
 editingId=null;
 for(const id of ['name','url','connection','telemetry-connection'])$(id).value='';
 $('editor-title').textContent='Add an engine';
 $('save').textContent='Save engine';$('cancel-edit').hidden=true;
}
function clearEngineView(){
 previous=null;latest=null;
 for(const id of ['cards','host-cards','warnings','summary','chart'])$(id).replaceChildren();
 $('models').replaceChildren(node('li','No snapshot yet.'));
 $('mode').textContent='Not connected';
 $('status').textContent=selected?selected.name+': no snapshot yet. Read once to connect.':'Choose an engine to read measurements.';
 $('average-note').textContent='Start a session or select saved history to view a summary.';
 $('session-label').textContent='No active recording.';
 $('collector-config').value=selected?.telemetryConnection || '';
 error(null);hostState();updateControls();
}
function format(value,unit){
 if(value===null || value===undefined || !Number.isFinite(value))return 'Unavailable';
 if(unit==='bytes'){const gb=value/1073741824;return gb.toFixed(2)+' GiB';}
 return value.toLocaleString(undefined,{maximumFractionDigits:2})+(unit?' '+unit:'');
}
function node(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
function render(snapshot){
 latest=snapshot;$('cards').replaceChildren();$('host-cards').replaceChildren();
 const hasHost=Object.keys(FIELDS).some(k=>!engineFields.has(k)&&Number.isFinite(snapshot.values[k]));hostState(hasHost);
 for(const key of Object.keys(FIELDS)){
  if(!engineFields.has(key)&&!Number.isFinite(snapshot.values[key]))continue;
  const [label,unit]=FIELDS[key],card=node('div','');card.className='card';card.append(node('span',label),node('strong',format(snapshot.values[key],unit)));
  if(key==='prefillTps'||key==='outputTps')card.append(node('span','Active processing rate from counter deltas'));
  $(engineFields.has(key)?'cards':'host-cards').append(card);
 }
 $('models').replaceChildren(...(snapshot.models.length?snapshot.models.map(m=>node('li',m.name+' · '+m.state)):[node('li','Model listing unavailable.')]));
 $('warnings').replaceChildren(...snapshot.warnings.filter(x=>!x.startsWith('Host collector unavailable:')).map(x=>node('li',x)));
 $('status').textContent='Snapshot '+new Date(snapshot.at).toLocaleString()+' · Engine: '+snapshot.health+(snapshot.sleeping===true?' (sleeping)':'')+' · '+snapshot.hostScope;
}
function renderSummary(samples){
 const out=summarize(samples);$('average-note').textContent=out.averageMethod+' '+out.count+' snapshots.';
 $('summary').replaceChildren(...Object.entries(out.metrics).filter(([key,m])=>engineFields.has(key)||m.count>0).map(([,m])=>{const tr=node('tr','');[m.label,format(m.low,m.unit),format(m.peak,m.unit),format(m.average,m.unit),m.count].forEach(x=>tr.append(node('td',x)));return tr;}));
 const svg=$('chart');svg.replaceChildren();let points=0;
 const max=Math.max(1,...samples.flatMap(s=>[s.values.prefillTps,s.values.outputTps]).filter(Number.isFinite));
 const start=Date.parse(samples[0]?.at),end=Date.parse(samples.at(-1)?.at);
 for(const [key,color] of [['prefillTps','#84bcff'],['outputTps','#6fe0bc']]){
  let segment=[];
  const flush=()=>{if(!segment.length)return;const p=document.createElementNS('http://www.w3.org/2000/svg','polyline');p.setAttribute('points',segment.join(' '));p.setAttribute('fill','none');p.setAttribute('stroke',color);p.setAttribute('stroke-width','2');svg.append(p);segment=[];};
  samples.forEach(s=>{
   const v=s.values[key];if(!Number.isFinite(v)){flush();return;}
   const x=10+(Date.parse(s.at)-start)*880/Math.max(end-start,1),y=170-v*160/max;
   segment.push(x+','+y);
   const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
   dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));dot.setAttribute('r','3');dot.setAttribute('fill',color);dot.dataset.metric=key;
   const title=document.createElementNS('http://www.w3.org/2000/svg','title');
   title.textContent=FIELDS[key][0]+': '+format(v,'tok/s')+' · '+new Date(s.at).toLocaleString();dot.append(title);svg.append(dot);points++;
  });flush();
 }
 if(!points){
  const message=document.createElementNS('http://www.w3.org/2000/svg','text');
  message.setAttribute('x','10');message.setAttribute('y','90');message.setAttribute('fill','currentColor');
  message.textContent='No active throughput samples recorded.';svg.append(message);
 }
}
function populate(){
 $('engines').replaceChildren(node('option','Choose an engine'));$('engines').firstChild.value='';
 profiles.forEach(p=>{const o=node('option',p.name);o.value=p.id;$('engines').append(o);});
 if(selected)$('engines').value=selected.id;
 $('collector-config').value=selected?.telemetryConnection || '';hostState();
 updateControls();
}
async function loadHistory(){
 const r=await store('store.list',{prefix:'session/',limit:1000});$('history').replaceChildren();
 for(const k of r.keys.filter(k=>k.key.split('/').length===2).reverse()){const o=node('option',new Date(Number(k.key.split('/')[1])).toLocaleString());o.value=k.key;$('history').append(o);}
}
function sessionRecord(record,samples=record.samples){
 return {id:record.id,engine:record.engine,startedAt:record.startedAt,stoppedAt:record.stoppedAt || null,count:samples.length,summary:summarize(samples)};
}
async function persistSample(snapshot){
 const nextSamples=[...session.samples,snapshot], index=nextSamples.length;
 // The session count is the commit marker. A metadata failure leaves an
 // uncommitted slot, which the next successful sample may overwrite.
 await set('sample/'+session.id+'/'+String(index).padStart(4,'0'),snapshot);
 await set('session/'+session.id,sessionRecord(session,nextSamples));
 session.samples=nextSamples;
}
async function accept(input,source){
 if(!selected)throw new Error('Choose an engine first.');
 if(input.engineId && input.engineId!==selected.id)throw new Error('Snapshot belongs to a different engine.');
 const snapshot=normalize({...input,engineId:selected.id},previous);
 if(previous && Date.parse(snapshot.at)<=Date.parse(previous.at))throw new Error('Snapshot timestamp must be newer than the previous snapshot.');
 previous=snapshot;render(snapshot);$('mode').textContent=source;
 if(session){
  if(session.samples.length>=600)throw new Error('Session limit reached (600 samples). Stop and save this session.');
  await persistSample(snapshot);renderSummary(session.samples);
 }
}
async function poll(){
 if(!selected?.connection)throw new Error('Choose an engine with an approved connection name.');
 const input=await call('read_engine',{connection:selected.connection,url:selected.url,engineId:selected.id,telemetryConnection:selected.telemetryConnection});
 await accept(input,'Live · '+selected.name);
}
function schedule(){
 if(!session)return;
 timer=setTimeout(()=>{if(busy){schedule();return;}run(async()=>{
  if(!session)return;
  try{await poll();}catch(e){error(e);$('status').textContent='Sample failed; previous data is stale. No sample recorded.';}
  if(session?.samples.length>=600){clearTimeout(timer);$('session-label').textContent='600-sample limit reached. Stop & summarize to finish.';return;}
  schedule();
 });},Number($('interval').value)*1000);
}
$('save').addEventListener('click',()=>run(async()=>{
 if(!ready)throw new Error('Saved engines are still loading. Reload if the connection failed.');
 if(session)throw new Error('Stop recording before changing engines.');
 const id=editingId || crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
 const p=profile({name:$('name').value,url:$('url').value,connection:$('connection').value,telemetryConnection:$('telemetry-connection').value,id});
 if(editingId && !profiles.some(p=>p.id===editingId))throw new Error('Engine no longer exists. Reload saved engines.');
 const updatedProfiles=editingId?profiles.map(item=>item.id===editingId?p:item):[...profiles,p];
 const result=await set('profiles',{profiles:updatedProfiles},profilesVersion);
 profilesVersion=result.version;profiles=updatedProfiles;selected=p;resetEditor();populate();clearEngineView();
 $('status').textContent='Engine saved: '+p.name+'. Read once to connect.';
}));
$('edit').addEventListener('click',()=>{
 if(busy || !ready || session || !selected)return;
 editingId=selected.id;
 $('name').value=selected.name;$('url').value=selected.url;
 $('connection').value=selected.connection;$('telemetry-connection').value=selected.telemetryConnection || '';
 $('editor').open=true;$('editor-title').textContent='Edit engine';
 $('save').textContent='Save changes';$('cancel-edit').hidden=false;
 error(null);$('name').focus();
});
$('cancel-edit').addEventListener('click',()=>{if(!busy && !session)resetEditor();});
$('engines').addEventListener('change',()=>{if(session||busy){$('engines').value=selected?.id || '';return;}selected=profiles.find(p=>p.id===$('engines').value)||null;resetEditor();clearEngineView();});
$('history').addEventListener('change',updateControls);
$('remove').addEventListener('click',()=>run(async()=>{
 if(!selected || session)throw new Error('Stop recording before removing an engine.');
 const nextProfiles=profiles.filter(p=>p.id!==selected.id),result=await set('profiles',{profiles:nextProfiles},profilesVersion);profilesVersion=result.version;profiles=nextProfiles;selected=null;resetEditor();populate();clearEngineView();
}));
$('save-collector').addEventListener('click',()=>run(async()=>{
 if(!selected||session)throw new Error('Choose an engine and stop recording before changing its collector.');
 const updated=profile({...selected,telemetryConnection:$('collector-config').value});
 const updatedProfiles=profiles.map(p=>p.id===updated.id?updated:p);
 const result=await set('profiles',{profiles:updatedProfiles},profilesVersion);
 profilesVersion=result.version;profiles=updatedProfiles;selected=updated;
 resetEditor();clearEngineView();
 $('status').textContent='Collector connection saved. Read once to check it.';
}));
$('refresh').addEventListener('click',()=>run(poll));
$('start').addEventListener('click',()=>run(async()=>{
 if(!selected)throw new Error('Choose an engine first.');
 if(session)return;
 const candidate={id:String(Date.now()),engine:{...selected},startedAt:new Date().toISOString(),samples:[]};
 await set('session/'+candidate.id,sessionRecord(candidate),0);
 session=candidate;previous=null;renderSummary([]);
 $('session-label').textContent='Recording '+selected.name+'. Keep this page open. Failed samples are omitted.';
 try{await poll();}finally{schedule();}
}));
$('stop').addEventListener('click',()=>run(async()=>{
 if(!session)return;clearTimeout(timer);
 const finished={...session,stoppedAt:new Date().toISOString()};
 try{await set('session/'+session.id,sessionRecord(finished));}catch(e){schedule();throw e;}
 renderSummary(session.samples);session=null;$('session-label').textContent='Session stopped and saved.';await loadHistory();
}));
$('import').addEventListener('click',()=>run(async()=>{await accept(JSON.parse($('snapshot').value),'Manual snapshot');}));
$('view').addEventListener('click',()=>run(async()=>{
 if(session)throw new Error('Stop recording before opening history.');
 const key=$('history').value;if(!key)return;const saved=await get(key);if(!saved)throw new Error('Session not found.');
 const count=saved.value.count,samples=[];
 if(!Number.isInteger(count)||count<0||count>600)throw new Error('Saved session has an invalid sample count.');
 for(let i=1;i<=count;i++){
  const entry=await get('sample/'+saved.value.id+'/'+String(i).padStart(4,'0'));
  if(!entry)throw new Error('Saved session is incomplete: sample '+i+' is missing.');
  samples.push(entry.value);
 }
 clearEngineView();
 if(samples.length)render(samples.at(-1));
 renderSummary(samples);$('mode').textContent='Saved session · '+saved.value.engine.name;
 if(!samples.length)$('status').textContent='Saved session contains no committed samples.';
}));
$('delete-session').addEventListener('click',()=>run(async()=>{
 if(session)throw new Error('Stop recording first.');
 const key=$('history').value;if(!key)return;const id=key.split('/')[1];
 const list=await store('store.list',{prefix:'sample/'+id+'/',limit:1000});
 for(const k of list.keys)await store('store.delete',{key:k.key});
 await store('store.delete',{key});await loadHistory();
}));
document.addEventListener('visibilitychange',()=>{if(session && document.hidden)$('session-label').textContent='Page hidden: browser may throttle monitoring. No samples are invented for gaps.';});
async function initialize(){
 await run(async()=>{
  $('retry-load').hidden=true;$('status').textContent='Opening your saved engines…';
  try{
   const entry=await get('profiles');
   profiles=entry?.value?.profiles || [];profilesVersion=entry?.version || 0;
   if(profiles.length===1)selected=profiles[0];
   populate();
   try{await loadHistory();}catch(e){error(e);}
   ready=true;
   $('status').textContent='Ready. Choose an engine, then read once or start recording.';
  }catch(e){
   if(!ready){
    $('status').textContent='Saved engines could not be loaded. Check the error and retry.';
    $('retry-load').hidden=false;
   }
   throw e;
  }
 });
}
$('retry-load').addEventListener('click',initialize);
$('discover-connections').addEventListener('click',()=>run(async()=>{
 const result=await call('connection_options',{});
 const engines=result.connections.filter(c=>c.paths.includes('/health')||c.paths.includes('/metrics'));
 const telemetry=result.connections.filter(c=>c.paths.includes('/telemetry'));
 for(const [id,list] of [['approved-engine',engines],['approved-telemetry',telemetry]]) {
  const select=$(id);select.textContent='';const blank=document.createElement('option');blank.value='';blank.textContent=id==='approved-engine'?'Choose…':'None';select.append(blank);
  for(const c of list){const option=document.createElement('option');option.value=c.id;option.textContent=c.id+' · '+c.origin;option.dataset.origin=c.origin;select.append(option);}
 }
 $('engine-picker').hidden=false;$('telemetry-picker').hidden=false;
 if(!engines.length)throw new Error('No engine health reads are approved. Open plugin setup and choose an engine connection.');
}));
$('approved-engine').addEventListener('change',()=>{
 const option=$('approved-engine').selectedOptions[0];
 if(!option.value)return;
 $('connection').value=option.value;$('url').value=option.dataset.origin;
 if(!$('name').value)$('name').value=option.value;
});
$('approved-telemetry').addEventListener('change',()=>{$('telemetry-connection').value=$('approved-telemetry').value;});
initialize();
