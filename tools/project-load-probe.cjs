/* Manual load probe. Synthetic data only; refuses any database except incident_test.
 * Run from repository root after build: node --max-old-space-size=384 tools/project-load-probe.cjs 10 2 100
 * Arguments: residents, photos per resident, simulated MAX response time in ms.
 * Uses real webhook handlers, PostgreSQL, legal gate, inbox/outbox and API pacing.
 */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const http = require('node:http');
const [residents, photos, apiDelay] = process.argv.slice(2).map(Number);
if (!Number.isInteger(residents) || residents < 1 || residents > 1000 || ![0,2,4].includes(photos) || !(apiDelay >= 0 && apiDelay <= 1000)) throw Error('Invalid load probe arguments');
if (!process.env.TEST_DATABASE_URL) throw Error('TEST_DATABASE_URL required');
const url = new URL(process.env.TEST_DATABASE_URL);
if (url.pathname !== '/incident_test') throw Error('Refusing non-test database');
url.hostname = '127.0.0.1'; url.pathname = '/incident_test'; url.searchParams.set('connection_limit', '5');
process.env.DATABASE_URL = url.toString();
Object.assign(process.env, { NODE_ENV:'test', LOG_LEVEL:'silent', LOG_PRETTY:'false', BOT_TOKEN:'load-probe-dummy-token', BOT_MODE:'webhook', WEBHOOK_SECRET:'load-probe-secret', WEBHOOK_AUTO_REGISTER:'false', DISTRIBUTION_CHAT_ID:'-1001', REVIEW_CHAT_ID:'-1002', DELIVERY_ALERT_CHAT_ID:'-1005', SLA_ENABLED:'false', INBOX_CONCURRENCY:'8', OUTBOX_CONCURRENCY:'8', DAILY_INCIDENT_LIMIT:'50', MEDIA_STORAGE:'local', MEDIA_LOCAL_PATH:'./data/load-probe', LEGAL_CONSENT_REQUIRED:'true', LEGAL_DOCUMENTS_BASE_URL:'https://example.test/documents', LEGAL_DOCUMENT_VERSION:'1.0', LEGAL_USER_AGREEMENT_VERSION:'1.1', LEGAL_USER_AGREEMENT_SHA256:'a'.repeat(64), LEGAL_PRIVACY_POLICY_SHA256:'b'.repeat(64), LEGAL_PERSONAL_DATA_CONSENT_SHA256:'c'.repeat(64), ADMINS:'9001', DISPATCHERS:'9002', APPROVERS:'9003', RESPONDERS:'9004' });
global.fetch = async () => { throw Error('External fetch forbidden in load probe'); };
const load = p => require(path.resolve('dist',p));
const { PrismaClient } = require('@prisma/client');
const { buildServices } = load('app/container');
const { MaxClient } = load('max/max-client');
const { MaxMessageService } = load('max/max-message.service');
const { MediaService } = load('media/media.service');
const { photoToken } = load('media/max-photo-reference');
const { UpdateDispatcher, updatePartition } = load('server/update-dispatcher');
const { createWebhookServer } = load('server/webhook.server');
const { handleMessageUpdate } = load('bot/handlers/message.handler');
const { handleCallbackUpdate } = load('bot/callbacks');
const p = new PrismaClient();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const quantiles = xs => { const a=[...xs].sort((a,b)=>a-b); return {p50:+(a[Math.ceil(a.length*.5)-1]||0).toFixed(1),p95:+(a[Math.ceil(a.length*.95)-1]||0).toFixed(1),max:+(a.at(-1)||0).toFixed(1)}; };
const ready = () => new Promise(resolve => { const start=performance.now(); const req=http.get('http://127.0.0.1:3000/ready',res=>{res.resume();res.on('end',()=>resolve({ok:res.statusCode===200,ms:performance.now()-start}));});req.setTimeout(2500,()=>req.destroy());req.on('error',()=>resolve({ok:false,ms:2500})); });
let app, dispatcher, messages, timer; let start=0, peakRSS=0, peakInbox=0,peakOutbox=0,peakActive=0, active=0, seq=0, failure;
const activeUsers=new Set(), previews=new Map(), confirmations=new Map(), cards=[], ack=[], processing=[], readyTimes=[], pendingPosts=new Set();
const liveMessages=new Map(), pinned=new Map(); const sent=[]; const routeOrder=new Map(); const loop=monitorEventLoopDelay({resolution:20});
async function main(){
  const db=await p.$queryRawUnsafe('SELECT current_database() AS name'); if(db[0].name!=='incident_test')throw Error('Refusing non-test database');
  const tableRows=await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'`);
  await p.$executeRawUnsafe('TRUNCATE '+tableRows.map(r=>'"'+r.tablename.replaceAll('"','""')+'"').join(',')+' RESTART IDENTITY CASCADE');
  const ids=Array.from({length:residents},(_,i)=>810000+i);
  const users=ids.map(id=>({id:randomUUID(),maxUserId:BigInt(id),displayName:'Нагрузочный тест',requesterName:'Тестовый Житель',requesterPhone:'+79001112233'}));
  await p.user.createMany({data:users});
  await p.legalAcceptance.createMany({data:users.flatMap(u=>['USER_AGREEMENT','PERSONAL_DATA_CONSENT'].map(type=>({userId:u.id,maxUserId:u.maxUserId,type,documentVersion:type==='USER_AGREEMENT'?'1.1':'1.0',documentUrl:'https://example.test/documents',documentSha256:(type==='USER_AGREEMENT'?'a':'c').repeat(64),confirmationText:'Synthetic setup'})))});
  await p.operatorSession.createMany({data:ids.map(id=>({maxUserId:BigInt(id),chatId:BigInt(id),type:'WAITING_INCIDENT_TEXT',expiresAt:new Date(Date.now()+600000),data:{requesterName:'Тестовый Житель',requesterPhone:'+79001112233',selectedCategoryId:null,problemMunicipalityCode:'KALUGA_CITY',problemMunicipalityName:'Город Калуга',problemLocality:null}}))});
  const tokens=id=>Array.from({length:photos},(_,i)=>`probe-${id}-${i}`);
  const send=async(target,id,text,extra)=>{
    await sleep(apiDelay); const mid=`load-${++seq}`; const ts=performance.now()-start;
    const imageTokens=(extra?.attachments||[]).filter(a=>a.type==='image').map(a=>a.payload.token);
    sent.push({target,id,text,tokens:imageTokens}); liveMessages.set(mid,{recipient:{chat_id:id},body:{mid,text,attachments:extra?.attachments||[]}});
    if(target==='user'&&text.includes('ПРОВЕРЬТЕ ОБРАЩЕНИЕ'))previews.set(id,ts);
    if(target==='user'&&text.includes('Обращение зарегистрировано'))confirmations.set(id,ts);
    if(target==='chat'&&id===-1001&&text.includes('INC-'))cards.push(ts);
    return {body:{mid}};
  };
  const max=new MaxClient({api:{sendMessageToUser:(id,t,e)=>send('user',id,t,e),sendMessageToChat:(id,t,e)=>send('chat',id,t,e),answerOnCallback:async()=>{await sleep(apiDelay);return{success:true};},getMessage:async(mid)=>{await sleep(apiDelay);const m=liveMessages.get(mid);if(!m)throw Error('Unknown mock message');return m;},getPinnedMessage:async(id)=>({message:liveMessages.get(pinned.get(id))||null}),pinMessage:async(id,mid)=>{pinned.set(id,mid);return{success:true};},editMessage:async(mid,body)=>{await sleep(apiDelay);const m=liveMessages.get(mid);if(!m)throw Error('Unknown mock message');m.body={...m.body,...body};return{success:true};},deleteMessage:async()=>({success:true})}});
  const forbidden=async()=>{throw Error('Local media access forbidden');};
  const storage={save:forbidden,load:forbidden,remove:forbidden};
  max.downloadFromUrl=forbidden;max.uploadImage=forbidden;
  messages=new MaxMessageService(max,{prisma:p,storage});
  const services=buildServices(p,{messages,media:new MediaService(storage,max),storage});services.max=max;
  const submit=async update=>{const t=performance.now();const response=await app.inject({method:'POST',url:services.config.WEBHOOK_PATH,headers:{'x-max-bot-api-secret':'load-probe-secret'},payload:update});ack.push(performance.now()-t);if(response.statusCode!==200)throw Error('Webhook rejected: '+response.statusCode);};
  const confirm=id=>({update_type:'message_callback',timestamp:Date.now(),callback:{callback_id:`confirm-${id}`,user:{user_id:id,name:'Тестовый Житель'},payload:'user:draft-confirm'},message:{sender:{user_id:999,is_bot:true,name:'Искра'},recipient:{chat_id:id,chat_type:'dialog'},body:{mid:`preview-${id}`}}});
  dispatcher=new UpdateDispatcher(p,{dispatch:async update=>{
    const key=updatePartition(update),t=performance.now();if(activeUsers.has(key))throw Error('Same user overlap');activeUsers.add(key);peakActive=Math.max(peakActive,++active);
    try{routeOrder.set(key,[...(routeOrder.get(key)||[]),update.update_type]);if(update.update_type==='message_created'){
      await handleMessageUpdate(services,{update});const id=update.message.sender.user_id;
      if(!previews.has(id))throw Error('Preview missing');
      const task=submit(confirm(id)).catch(e=>{failure=e;}).finally(()=>pendingPosts.delete(task));pendingPosts.add(task);
    }else await handleCallbackUpdate(services,{update});}
    finally{processing.push(performance.now()-t);active--;activeUsers.delete(key);}
  }},8);
  app=await createWebhookServer(services,dispatcher);await app.ready();await dispatcher.start();messages.start();
  start=performance.now();const cpuStart=process.cpuUsage();loop.enable();
  const resources=()=>{peakRSS=Math.max(peakRSS,process.memoryUsage().rss);const match=fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/);if(match&&Number(match[1])<700*1024)failure=Error('Low available host memory');};
  timer=setInterval(resources,500);resources();let nextProgress=0,nextHealth=0,badReady=0;
  const initial=Promise.all(ids.map(id=>submit({update_type:'message_created',timestamp:Date.now(),message:{sender:{user_id:id,name:'Тестовый Житель'},recipient:{chat_id:id,chat_type:'dialog'},body:{mid:`photo-${id}`,text:`Не горит фонарь по адресу Ленина, ${id}`,attachments:tokens(id).map(token=>({type:'image',payload:{token,url:'https://unused.invalid/'+token}}))}}}))).catch(e=>{failure=e;});
  while(true){
    await sleep(250);if(failure)throw failure;
    const elapsed=performance.now()-start;if(elapsed>420000)throw Error('Stage exceeded 7-minute limit');
    const [inbox,outbox,count]=await Promise.all([p.inboundUpdate.groupBy({by:['status'],_count:true}),p.outboundMessage.groupBy({by:['status'],_count:true}),p.incident.count()]);
    const pendingIn=inbox.filter(r=>r.status!=='PROCESSED').reduce((s,r)=>s+r._count,0),pendingOut=outbox.filter(r=>r.status!=='SENT').reduce((s,r)=>s+r._count,0);peakInbox=Math.max(peakInbox,pendingIn);peakOutbox=Math.max(peakOutbox,pendingOut);
    if(inbox.some(r=>r.status==='FAILED')||outbox.some(r=>r.status==='FAILED'))throw Error('Queue failure');
    if(elapsed>=nextHealth){const h=await ready();readyTimes.push(h.ms);badReady=h.ok?0:badReady+1;if(badReady>=2)throw Error('Production readiness degraded');nextHealth=elapsed+5000;}
    if(elapsed>=nextProgress){console.log(JSON.stringify({progress:true,residents,photos,seconds:+(elapsed/1000).toFixed(1),registered:count,confirmed:confirmations.size,cards:cards.length,inbox:pendingIn,outbox:pendingOut,rssMB:+(process.memoryUsage().rss/1048576).toFixed(1)}));nextProgress=elapsed+10000;}
    if(count===residents&&cards.length===residents&&confirmations.size===residents&&pendingIn===0&&pendingOut===0&&pendingPosts.size===0)break;
  }
  await initial;await dispatcher.waitForIdle();await messages.waitForIdle();
  const elapsed=performance.now()-start,cpu=process.cpuUsage(cpuStart);
  const incidents=await p.incident.findMany({include:{attachments:true}});let ownershipErrors=0;
  for(const incident of incidents){const id=Number(incident.requesterMaxUserId),expected=tokens(id).sort().join('|');if(incident.text!==`Не горит фонарь по адресу Ленина, ${id}`||incident.attachments.map(a=>photoToken(a.storageKey)).sort().join('|')!==expected)ownershipErrors++;
    const previewsFor=sent.filter(s=>s.target==='user'&&s.id===id&&s.text.includes('ПРОВЕРЬТЕ ОБРАЩЕНИЕ'));const cardsFor=sent.filter(s=>s.target==='chat'&&s.text.includes(incident.publicCode));if(previewsFor.length!==1||cardsFor.length!==1||previewsFor[0].tokens.sort().join('|')!==expected||cardsFor[0].tokens.sort().join('|')!==expected)ownershipErrors++;
    if((routeOrder.get(`user:${id}`)||[]).join(',')!=='message_created,message_callback')ownershipErrors++;
  }
  if(ownershipErrors||new Set(incidents.map(i=>i.publicCode)).size!==residents)throw Error('Ownership/order/uniqueness failed');
  const result={residents,photosPerResident:photos,simulatedApiMs:apiDelay,seconds:+(elapsed/1000).toFixed(2),incidents:incidents.length,photos:incidents.reduce((n,i)=>n+i.attachments.length,0),httpAcknowledgementMs:quantiles(ack),previewMs:quantiles([...previews.values()]),residentConfirmationMs:quantiles([...confirmations.values()]),distributionCardMs:quantiles(cards),handlerMs:quantiles(processing),peakInbox,peakOutbox,peakActive,peakRssMB:+(peakRSS/1048576).toFixed(1),cpuCorePercent:+((cpu.user+cpu.system)/1000/elapsed*100).toFixed(1),eventLoopP99Ms:+(loop.percentile(99)/1e6).toFixed(1),productionReadyMs:quantiles(readyTimes),errors:0,ownershipErrors:0};
  fs.mkdirSync('tmp/load-results',{recursive:true});fs.writeFileSync(`tmp/load-results/${residents}-${photos}-${apiDelay}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({result}));
}
main().catch(e=>{console.error(JSON.stringify({fatal:e.message,residents,photos}));process.exitCode=1;}).finally(async()=>{clearInterval(timer);loop.disable();dispatcher?.stop();messages?.stop();if(process.exitCode){await p.$disconnect();process.exit(1);}await dispatcher?.waitForIdle();await messages?.waitForIdle();await app?.close();await p.$disconnect();});
