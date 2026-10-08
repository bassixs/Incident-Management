'use strict';
// Standalone GET-only connectivity checks, no app bootstrap, no subscription mutation.
const dns=require('node:dns').promises,fs=require('node:fs'),crypto=require('node:crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function get(url,auth=false,media=false){
 const u=new URL(url);if(u.protocol!=='https:')throw Error('HTTPS_REQUIRED');
 const out={host:u.hostname,pathHash:hash(u.pathname),media};
 try{out.dnsCount=(await dns.lookup(u.hostname,{all:true})).length;const r=await fetch(u,{headers:auth&&process.env.BOT_TOKEN?{Authorization:process.env.BOT_TOKEN}:{},redirect:'error',signal:AbortSignal.timeout(20000)});out.status=r.status;out.contentType=(r.headers.get('content-type')||'').split(';')[0];let bytes=0;const limit=media?25*1024*1024:65536;for await(const b of r.body){bytes+=b.length;if(bytes>limit)throw Error('BODY_LIMIT');}out.bytes=bytes;out.bodyStored=false;out.ok=media?r.ok:auth&&process.env.BOT_TOKEN?r.ok:r.status===401||r.ok;}catch(e){out.ok=false;out.error=e.cause?.code||(['BODY_LIMIT','HTTPS_REQUIRED'].includes(e.message)?e.message:e.name);}return out;
}
(async()=>{const p=JSON.parse(fs.readFileSync(0,'utf8'));const results=[];
 results.push({kind:'max',...await get((process.env.MAX_API_BASE_URL||'https://platform-api2.max.ru').replace(/\/$/,'')+'/me',true)});
 for(const url of p.attachments||[])results.push({kind:'attachment',...await get(url,false,true)});
 if(p.publicDomain)results.push({kind:'own-public-domain-internal-diagnostic-only',...await get('https://'+p.publicDomain+'/handover-check')});
 console.log(JSON.stringify({results,attachmentChecksProvided:(p.attachments||[]).length,ownDomainFailureNotWebhookFailure:true}));process.exitCode=results.some(r=>r.kind!=='own-public-domain-internal-diagnostic-only'&&!r.ok)?2:0;
})().catch(()=>{console.error('NETWORK_PROBE_INVALID_INPUT');process.exitCode=2});
