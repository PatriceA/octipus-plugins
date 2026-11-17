import { request } from 'node:http';

/** Host API transport derived from Octipus's with-store template. Token lives for one call only. */
export function hostRequest(host, path, body) {
  if(!host?.token || !host.scopes?.includes('connections:read'))throw new Error('Approve connections:read for this plugin, then enable it. This Octipus build must include the connection bridge.');
  const proxy=process.env.HTTP_PROXY || process.env.http_proxy;
  if(!proxy)throw new Error('Host API egress proxy unavailable.');
  const p=new URL(proxy), target=new URL('/api/plugin-host'+path,host.url), payload=JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=request({host:p.hostname,port:Number(p.port || 80),method:'POST',path:target.href,headers:{host:target.host,authorization:'Bearer '+host.token,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      const chunks=[];let length=0;
      res.on('data',c=>{length+=c.length;if(length>1200000){res.destroy(new Error('Host response too large.'));return;}chunks.push(c);});
      res.on('error',reject);
      res.on('end',()=>{try{const out=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode<200 || res.statusCode>=300)reject(new Error(out.error || 'Host bridge returned '+res.statusCode));else resolve(out);}catch(e){reject(e);}});
    });
    req.setTimeout(12000,()=>req.destroy(new Error('Host bridge timed out.')));
    req.on('error',reject);req.end(payload);
  });
}

export async function readEngine(args, host, send=hostRequest) {
  const url=new URL(String(args.url || ''));
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)throw new Error('Use a credential-free engine base URL.');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(args.connection || ''))throw new Error('Select an approved connection name.');
  const base=url.pathname.replace(/\/$/,'');
  const paths={health:base+'/health',models:base+'/v1/models',props:base+'/props',metrics:base+'/metrics'};
  const started=Date.now(), warnings=[], out={engineId:String(args.engineId || '')};
  let successful=0;
  await Promise.all(Object.entries(paths).map(async([key,path])=>{
    try {
      const response=await send(host,'/connections/get',{connection:args.connection,path,expectedOrigin:url.origin});
      if(!response.ok){warnings.push(key+': HTTP '+response.status+(key==='metrics'?' (enable --metrics)':''));return;}
      successful++;out[key]=response.body;
    }catch(e){warnings.push(key+': '+e.message);}
  }));
  if(!successful)throw new Error(warnings.join('; '));
  if(args.telemetryConnection){
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(args.telemetryConnection))throw new Error('Invalid telemetry connection name.');
    try {
      const telemetry=await send(host,'/connections/get',{connection:args.telemetryConnection,path:'/telemetry'});
      if(telemetry.ok && telemetry.body?.host){
        const age=Date.now()-Date.parse(telemetry.body.at);
        if(!Number.isFinite(age) || age>30000 || age < -5000)warnings.push('Host collector snapshot stale or clock skewed; host values withheld.');
        else {out.host=telemetry.body.host;out.hostScope=telemetry.body.scope;warnings.push(...(telemetry.body.warnings || []));}
      } else warnings.push('Host collector: HTTP '+telemetry.status);
    }catch(e){warnings.push('Host collector: '+e.message);}
  }
  return {...out,at:new Date().toISOString(),latencyMs:Date.now()-started,warnings};
}
