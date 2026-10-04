import {randomUUID} from 'node:crypto';
import catalog from '../fixtures/resident-topic-catalog.json';
import { DraftScreenRecovery, deliverSavedScreen } from '../../src/bot/draft-screen-delivery';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {MaxMessageService} from '../../src/max/max-message.service';
import {MaxError} from '@maxhub/max-bot-api';
import {registerHandlers} from '../../src/bot/bot';
import {UpdateDispatcher} from '../../src/server/update-dispatcher';
import {parseCallbackPayload} from '../../src/max/callback-payload';
import {isResidentDraft} from '../../src/sessions/operator-session.service';
import {createTestPrisma,createHarness,resetDatabase,pushSchemaOnce,describeIntegration} from '../helpers/integration';


const active=catalog.filter((x:any)=>x.isActive);
const results:any[]=[];
const USER=555n;
describeIntegration('resident screen recovery through durable inbox and registered handlers',()=>{
 let db:any,h:any,inbox:UpdateDispatcher,refusals:any[],acks:any[],currentCase:string,sendHook:any;
 beforeAll(()=>{pushSchemaOnce();db=createTestPrisma();});
 afterAll(async()=>{await db.$disconnect();});
 beforeEach(async(ctx)=>{
  currentCase=ctx.task.name;refusals=[];acks=[];sendHook=undefined;
  await resetDatabase(db);await db.category.createMany({data:catalog});h=await createHarness(db);
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('LIVE_MAX_FORBIDDEN')}));
  vi.spyOn(h.services.max,'answerCallback').mockImplementation(async(_id:any,text:any)=>{acks.push(text);});
  vi.spyOn(h.services.max,'getChat').mockImplementation(async()=>{throw new Error('LIVE_MAX_FORBIDDEN')});
  const send=h.messages.send.bind(h.messages);
  vi.spyOn(h.messages,'send').mockImplementation(async(target:any,message:any)=>{
   if(sendHook)await sendHook(target,message);
   return send(target,message);
  });
  vi.spyOn(h.services.media,'ingestAll').mockImplementation(async(_prefix:any,media:any)=>media.map((x:any,i:number)=>({type:'IMAGE',storageKey:'fake-photo-'+i,maxToken:x.token,size:1})));
  registerHandlers(h.services);
  inbox=new UpdateDispatcher(db,h.services.max);
 });
 afterEach(async()=>{
  results.push({case:currentCase,refusals,incidents:await db.incident.count(),failedInbox:await db.inboundUpdate.count({where:{status:'FAILED'}}),networkCalls:vi.mocked(fetch).mock.calls.length});
  expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();
 });
 const session=()=>db.operatorSession.findUnique({where:{maxUserId_chatId:{maxUserId:USER,chatId:USER}}});
 const data=async()=>(await session())?.data;
 const screen=()=>h.messages.toUser(USER).at(-1)?.message;
 const buttons=(s=screen())=>s?.keyboard?.flat()??[];
 const button=(label:string,s=screen())=>{const b=buttons(s).find((x:any)=>x.text===label);expect(b,`visible button ${label}`).toBeTruthy();return b.payload;};
 const event=(payload:string,id:string=randomUUID())=>({update_type:'message_callback',timestamp:Date.now(),callback:{callback_id:id,user:{user_id:Number(USER),name:'Test',is_bot:false},payload},message:{timestamp:Date.now(),recipient:{chat_type:'dialog',chat_id:Number(USER)},body:{mid:'mid-'+(h.messages.sent.findLastIndex((x:any)=>x.message.keyboard?.flat().some((b:any)=>b.payload===payload))+1),text:'',attachments:[]}}});
 // Diagnostic oracle observes the exact guards without replacing/mocking their implementation.
 async function reason(payload:string){const p:any=parseCallbackPayload(payload);if(p?.action!=='draft-action')return null;const [token,index,extra]=(p.argument??'').split('~');const s=await session();const d=s?.data;
  if(!s)return 'NO_SESSION';if(s.expiresAt<=new Date())return 'EXPIRED';if(!isResidentDraft(s.type))return 'NOT_RESIDENT';if(!d?.draftToken)return 'NO_DRAFT_TOKEN';if(token!==d.screenToken)return 'SCREEN_TOKEN_MISMATCH';if(extra!==undefined||!/^\d{1,3}$/.test(index??''))return 'INDEX_FORMAT';const inner:any=parseCallbackPayload(d.screenActions?.[Number(index)]);if(!inner)return 'ACTION_MAP_EMPTY_OR_INDEX_MISSING';return null;
 }
 async function waitReady(id:string) {
  const row=await db.inboundUpdate.findUniqueOrThrow({where:{id}});
  // PostgreSQL rounds its default to milliseconds; do not sweep before it is due.
  await vi.waitFor(()=>expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now()),{timeout:1000,interval:10});
 }
 async function processReserved(r:any,payload?:string){const predicted=payload?await reason(payload):null;const start=acks.length;await waitReady(r.id);await inbox.kick();await inbox.waitForIdle();const row=await db.inboundUpdate.findUniqueOrThrow({where:{id:r.id}});const stale=acks.slice(start).some(x=>String(x).includes('Это действие устарело'));if(stale){refusals.push({guard:predicted??'LATER_GUARD_NEEDS_REVIEW',status:row.status});expect(predicted).not.toBeNull();}return row;}
 async function press(payload:string,id?:string){const r=await inbox.reserve(event(payload,id) as never);if(!r.fresh)return {duplicate:true};return processReserved(r,payload);}
 async function click(label:string){return press(button(label));}
 async function type(text:string,photos=false){const now=Date.now();const r=await inbox.reserve({update_type:'message_created',timestamp:now,message:{timestamp:now,sender:{user_id:Number(USER),name:'Test',is_bot:false},recipient:{chat_type:'dialog',chat_id:Number(USER)},body:{mid:randomUUID(),text,attachments:photos?[{type:'image',payload:{token:'fake-photo-token'}}]:[]}}} as never);return processReserved(r);}
 async function page(n:number){await press('user:new');for(let i=0;i<n;i++)await click('Вперёд ➡️');return structuredClone(screen());}
 async function recover(){
  const s=await session(),d=s.data;expect(d.draftScreenDelivery).toBeTruthy();
  await db.operatorSession.update({where:{id:s.id},data:{data:{...d,draftScreenDelivery:{...d.draftScreenDelivery,nextAttemptAt:0}}}});
  const worker=new DraftScreenRecovery(h.services);await worker.tick();worker.stop();await worker.waitForIdle();
 }
 async function finish(){
  let s=await session();if(s.type==='WAITING_INCIDENT_SELECTION'){const d=s.data;if(d.draftStage==='category')await click('Иное');
   // Fresh visible municipality control; find the bound semantic action only to locate its displayed button.
   const d2=await data();const ix=d2.screenActions.findIndex((raw:string)=>{const p:any=parseCallbackPayload(raw);return p?.action==='municipality'&&p.argument?.endsWith('~KALUGA_CITY')});expect(ix).toBeGreaterThanOrEqual(0);await press(button(buttons().find((b:any)=>b.payload?.endsWith('~'+ix)).text));
  }
  s=await session();if(s.type==='WAITING_INCIDENT_TEXT')await type('Яма у дома 12',true);
  expect(await db.incident.count()).toBe(0);await click('✅ Всё верно');expect(await db.incident.count()).toBe(1);
 }
 it('catalog and all page forward/back controls match active order; noop never consumes a screen',async()=>{
  await page(0);for(let p=0;p<5;p++){
   expect(buttons().slice(0,Math.min(6,26-p*6)).map((x:any)=>x.text)).toEqual(active.slice(p*6,p*6+6).map((x:any)=>x.name));
   const before=await data();await click(`${p+1} / 5`);expect(await data()).toEqual(before);
   if(p<4)await click('Вперёд ➡️');
  }
  for(let p=4;p>0;p--){await click('⬅️ Назад');expect(buttons().some((x:any)=>x.text===`${p} / 5`)).toBe(true)}
  expect(refusals).toHaveLength(0);
 });
 for(let p=0;p<5;p++)for(const c of active.slice(p*6,p*6+6))it(`fresh page ${p+1}: category ${c.code}`,async()=>{await page(p);await click(c.name);expect((await data()).selectedCategoryId).toBe(c.id);expect((await data()).draftStage).toBe('municipality');expect(refusals).toHaveLength(0)});
 it.each(['Иное','⬅️ Назад','5 / 5'])('fresh last page independent control %s',async(label)=>{await page(4);const before=await data();await click(label);expect(refusals).toHaveLength(0);if(label==='Иное'){expect((await data()).selectedCategoryId).toBeNull();await finish()}else if(label==='5 / 5')expect(await data()).toEqual(before);else expect(buttons().some((b:any)=>b.text==='4 / 5')).toBe(true)});
 it('previous-page topic after advancing is stale; current page still registers',async()=>{const first=await page(0);await click('Вперёд ➡️');const before=await data();await press(button(active[0]!.name,first));expect(await data()).toEqual(before);expect(refusals.at(-1).guard).toBe('SCREEN_TOKEN_MISMATCH');for(let i=1;i<4;i++)await click('Вперёд ➡️');await click('Иное');await finish()});
 it('15 old-page refusals reproduce the U14-shaped sequence without damaging last page',async()=>{const first=await page(0);for(let i=0;i<4;i++)await click('Вперёд ➡️');const before=await data();for(let i=0;i<15;i++)await press(button(active[i%6]!.name,first));expect(refusals).toHaveLength(15);expect(refusals.every(x=>x.guard==='SCREEN_TOKEN_MISMATCH')).toBe(true);expect(await data()).toEqual(before);await click('Иное');await finish()});
 it('same inbox event redelivery is deduplicated, rapid physical double-click is leased',async()=>{await page(4);const payload=button('Иное'),id=randomUUID();await press(payload,id);expect(await press(payload,id)).toEqual({duplicate:true});await press(payload);expect(refusals).toHaveLength(0);expect(acks.some(x=>String(x).includes('Предыдущее действие ещё выполняется'))).toBe(true);refusals.push({guard:'ACTION_LEASE_ACTIVE',evidence:'second physical click within 2 seconds'});await finish()});
 it('quick clicks admitted together preserve per-user order and do not register twice',async()=>{await page(4);const payload=button('Иное');const r=await Promise.all([inbox.reserve(event(payload) as never),inbox.reserve(event(payload) as never)]);for(const admitted of r)await waitReady(admitted.id!);await inbox.kick();await inbox.waitForIdle();expect((await data()).draftStage).toBe('municipality');expect(acks.filter(x=>String(x).includes('Предыдущее действие ещё выполняется'))).toHaveLength(1);refusals.push({guard:'ACTION_LEASE_ACTIVE',evidence:'second queued physical click within 2 seconds'});expect(await db.inboundUpdate.count({where:{id:{in:r.map(x=>x.id)},status:'PROCESSED'}})).toBe(2);await finish()});
 it('delayed event from earlier screen is rejected after already processed page change',async()=>{const old=await page(0);const delayed=event(button(active[0]!.name,old));await click('Вперёд ➡️');await processReserved(await inbox.reserve(delayed as never),delayed.callback.payload);expect(refusals.at(-1).guard).toBe('SCREEN_TOKEN_MISMATCH');expect(buttons().some((b:any)=>b.text==='2 / 5')).toBe(true)});
 it('menu / new / continue preserves draft and renews screen',async()=>{await page(4);const old=structuredClone(screen()),before=await data();await press('user:menu');await press('user:new');await click('Продолжить черновик');expect((await data()).draftToken).toBe(before.draftToken);await press(button('Иное',old));expect(refusals.at(-1).guard).toBe('SCREEN_TOKEN_MISMATCH');for(let i=0;i<4;i++)await click('Вперёд ➡️');await click('Иное');await finish()});
 it('gated next-screen send: second old click waits in inbox then is leased, new controls work',async()=>{
  await page(4);const old=button('Иное');let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let blocked=false;
  sendHook=async(_t:any,m:any)=>{if(m.immediatePreview&&!blocked){blocked=true;entered();await gate}};
  const r=await inbox.reserve(event(old) as never);await waitReady(r.id!);const work=inbox.kick();await started;const second=await inbox.reserve(event(old) as never);expect((await db.inboundUpdate.findUnique({where:{id:second.id}})).status).toBe('PENDING');await waitReady(second.id!);release();await work;await inbox.waitForIdle();sendHook=undefined;
  expect(acks.filter(x=>String(x).includes('Предыдущее действие ещё выполняется'))).toHaveLength(1);refusals.push({guard:'ACTION_LEASE_ACTIVE',evidence:'queued second click within 2 seconds'});expect((await db.inboundUpdate.findUnique({where:{id:r.id}})).status).toBe('PROCESSED');await finish();
 });
 it('send slower than acknowledgement and action lease: queued old click is stale after successful new screen',async()=>{
  await page(4);const old=button('Иное');let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let blocked=false;
  sendHook=async(_t:any,m:any)=>{if(m.immediatePreview&&!blocked){blocked=true;entered();await gate}};
  const r=await inbox.reserve(event(old) as never);await waitReady(r.id!);const work=inbox.kick();await started;
  const second=await inbox.reserve(event(old) as never);await new Promise(r=>setTimeout(r,2200));
  expect(acks.some(x=>String(x).includes('Принято, обрабатываю'))).toBe(true);expect((await db.inboundUpdate.findUnique({where:{id:second.id}})).status).toBe('PENDING');
  release();await work;await inbox.waitForIdle();sendHook=undefined;
  expect(acks.filter(x=>String(x).includes('Это действие устарело'))).toHaveLength(1);refusals.push({guard:'SCREEN_TOKEN_MISMATCH',evidence:'second physical click processed after 2s lease expired and current token changed'});
  expect((await db.inboundUpdate.findUnique({where:{id:r.id}})).status).toBe('PROCESSED');await finish();
 });
 it.each(['page','category'])('503 next %s screen persists recovery; restart delivers current controls',async(kind)=>{
  await page(kind==='page'?0:4);const before=await data(),old=button(kind==='page'?'Вперёд ➡️':'Иное');let once=true;
  sendHook=async(_t:any,m:any)=>{if(once&&m.immediatePreview){once=false;throw new MaxError(503,{code:'unavailable',message:'synthetic'})}};
  const row=await press(old);expect(row.status).toBe('PROCESSED');sendHook=undefined;
  expect(await db.outboundMessage.count()).toBe(0);const after=await data();expect(after.draftToken).toBe(before.draftToken);expect(after.screenToken).not.toBe(before.screenToken);
  // No delivered keyboard has the newly saved token. This is the reproduction, not an expected-success assertion.
  expect(h.messages.toUser(USER).some((x:any)=>x.message.keyboard?.flat().some((b:any)=>b.payload?.includes(after.screenToken)))).toBe(false);
  await press(old);expect(refusals.at(-1).guard).toBe('SCREEN_TOKEN_MISMATCH');expect(await db.incident.count()).toBe(0);
  await recover();expect((await data()).draftToken).toBe(before.draftToken);expect((await data()).draftScreenDelivery).toBeUndefined();
  if(kind==='page')for(let i=1;i<4;i++)await click('Вперёд ➡️');if(kind==='page')await click('Иное');await finish();
 });
 it.each([1,4])('real delivery and MAX retry chain: %i simulated 503 responses',async(failures)=>{
  await page(4);const old=button('Иное'),before=await data();
  const worker=new MaxMessageService(h.services.max,{prisma:db,storage:h.services.media as never});
  let calls=0;const api=vi.spyOn(h.services.max.api,'sendMessageToUser').mockImplementation(async()=>{calls++;if(calls<=failures)throw new MaxError(503,{code:'unavailable',message:'synthetic'});return {body:{mid:'sdk-synthetic-next'}} as never});
  sendHook=async(t:any,m:any)=>{if(m.immediatePreview)await worker.send(t,m)};
  try {
   const row=await press(old);sendHook=undefined;expect(calls).toBe(failures===1?2:4);expect((await data()).draftToken).toBe(before.draftToken);
   if(failures===1){expect(row.status).toBe('PROCESSED');expect((await data()).draftStage).toBe('municipality');await finish()}
   else {
    expect(row.status).toBe('PROCESSED');const after=await data();expect(h.messages.toUser(USER).some((x:any)=>x.message.keyboard?.flat().some((b:any)=>b.payload?.includes(after.screenToken)))).toBe(false);expect(await db.outboundMessage.count()).toBe(0);
    await press(old);expect(refusals.at(-1).guard).toBe('SCREEN_TOKEN_MISMATCH');await recover();await finish();
   }
  } finally {sendHook=undefined;worker.stop();await worker.waitForIdle();api.mockRestore()}
 });
 it('503 while editing category preserves text/photo/phone; stale rejection and resume keep them',async()=>{
  await page(4);await click('Иное');const d=await data();const ix=d.screenActions.findIndex((x:string)=>x.endsWith('~KALUGA_CITY'));await press(buttons().find((b:any)=>b.payload?.endsWith('~'+ix)).payload);await type('Яма у дома 12',true);
  await click('📞 Поделиться контактом');await type('8 (900) 123-45-67');await click('✏️ Исправить');
  const sd=await data();const fi=sd.screenActions.findIndex((x:string)=>x==='user:draft-field:category');expect(fi).toBeGreaterThanOrEqual(0);await press(buttons().find((b:any)=>b.payload?.endsWith('~'+fi)).payload);
  const before=await data(),old=button('Вперёд ➡️');let once=true;sendHook=async(_t:any,m:any)=>{if(once&&m.immediatePreview){once=false;throw new MaxError(503,{code:'unavailable',message:'synthetic'})}};
  expect((await press(old)).status).toBe('PROCESSED');sendHook=undefined;await press(old);await press('user:menu');await press('user:new');await click('Продолжить черновик');
  expect(await data()).toMatchObject({draftToken:before.draftToken,draftText:before.draftText,draftMedia:before.draftMedia,requesterPhone:before.requesterPhone,problemMunicipalityCode:before.problemMunicipalityCode});
  await click('✅ Всё верно');expect(await db.incident.count()).toBe(1);expect((await db.incident.findFirst()).requesterPhone).toBe('+7 900 123-45-67');expect(await db.incidentAttachment.count()).toBe(1);
 });

 it('retains old controls until replacement is delivered; failed retirement is retried without resending', async () => {
  await page(0); const oldId = (await data()).screenMessageId;
  const retire = vi.spyOn(h.messages, 'retireDraftScreen').mockResolvedValue(false);
  let fail = true;
  sendHook = async (_t:any,m:any) => { if (fail && m.immediatePreview) throw new MaxError(503,{code:'unavailable',message:'synthetic'}); };
  await click('Вперёд ➡️'); expect(retire).not.toHaveBeenCalled();
  fail=false; await recover();
  const now=await data(); expect(now.screenMessageId).not.toBe(oldId); expect(now.screenRetireIds).toContain(oldId);
  expect(retire).toHaveBeenCalledWith(oldId,expect.any(String));
  const sends=h.messages.sent.length; retire.mockResolvedValue(true);
  const current=await session();await db.operatorSession.update({where:{id:current.id},data:{data:{...now,screenRetireAt:0}}});
  await new DraftScreenRecovery(h.services).tick();
  expect((await data()).screenRetireIds).not.toContain(oldId);expect(h.messages.sent).toHaveLength(sends);
 });

 it.each(['expired','completed','replaced','resumed'])('pending recovery is fenced after draft is %s', async mode => {
  await page(0);const oldDraft=(await data()).draftToken;
  sendHook=async()=>{throw new MaxError(503,{code:'unavailable',message:'synthetic'})};
  await click('Вперёд ➡️');sendHook=undefined;
  const pending=await session();await db.operatorSession.update({where:{id:pending.id},data:{data:{...pending.data,draftScreenDelivery:{...pending.data.draftScreenDelivery,nextAttemptAt:0}}}});
  if(mode==='expired') await db.operatorSession.update({where:{id:pending.id},data:{expiresAt:new Date(Date.now()-1)}});
  else if(mode==='completed') { await press('user:menu');await press('user:new');await click('Продолжить черновик');for(let i=0;i<4;i++)await click('Вперёд ➡️');await click('Иное');await finish(); }
  else {await press('user:menu');await press('user:new');await click(mode==='resumed'?'Продолжить черновик':'Начать заново')}
  const before=await session(),count=h.messages.sent.length;
  await new DraftScreenRecovery(h.services).tick();
  expect(await session()).toEqual(before);expect(h.messages.sent).toHaveLength(count);expect(await db.incident.count()).toBe(mode==='completed'?1:0);
  if(mode==='replaced') expect(before.data.draftToken).not.toBe(oldDraft);
 });

 it.each(['clear','expire','replace'])('late delivery after %s cannot overwrite state and its known keyboard is retired', async mode=>{
  await page(0);sendHook=async()=>{throw new MaxError(503,{code:'unavailable',message:'synthetic'})};await click('Вперёд ➡️');sendHook=undefined;
  const send=h.messages.send.bind(h.messages);let late:string|undefined;let after:any;
  vi.spyOn(h.messages,'send').mockImplementationOnce(async(t:any,m:any)=>{
   const result=await send(t,m);late=result.firstMessageId;
   const current=await session();
   if(mode==='expire') await db.operatorSession.update({where:{id:current.id},data:{expiresAt:new Date(Date.now()-1)}});
   else await h.services.sessions.clear(USER,USER);
   if(mode==='replace') await h.services.sessions.start({maxUserId:USER,chatId:USER,type:'WAITING_INCIDENT_SELECTION',data:{draftToken:'replacement-draft',screenToken:'replacement-screen',draftTouchedAt:Date.now()}});
   after=await session();return result;
  });
  await recover();
  if(mode!=='expire') expect(await session()).toEqual(after);else expect(await session()).toBeNull();
  expect(h.messages.edits.some((e:any)=>e.messageId===late&&e.mode==='keyboard')).toBe(true);
  expect(await db.incident.count()).toBe(0);
 });

 it('caps attempts, respects delay, survives an interrupted sending lease and allows manual continuation',async()=>{
  await page(0);sendHook=async()=>{throw new MaxError(503,{code:'unavailable',message:'synthetic'})};await click('Вперёд ➡️');
  const count=h.messages.send.mock.calls.length;
  await new DraftScreenRecovery(h.services).tick();expect(h.messages.send.mock.calls).toHaveLength(count);
  // A fresh process sees only persisted state; an unexpired sending lease must wait.
  const interrupted=await session();await db.operatorSession.update({where:{id:interrupted.id},data:{data:{...interrupted.data,draftScreenDelivery:{...interrupted.data.draftScreenDelivery,status:'sending',nextAttemptAt:Date.now()+300000}}}});
  await new DraftScreenRecovery(h.services).tick();expect(h.messages.send.mock.calls).toHaveLength(count);
  for(let i=0;i<3;i++)await recover();
  expect((await data()).draftScreenDelivery).toMatchObject({attempts:4,status:'exhausted'});
  const exhaustedCount=h.messages.send.mock.calls.length;await recover();expect(h.messages.send.mock.calls).toHaveLength(exhaustedCount);
  sendHook=undefined;const token=(await data()).draftToken;await press('user:menu');await press('user:new');await click('Продолжить черновик');
  expect((await data()).draftToken).toBe(token);expect((await data()).draftScreenDelivery).toBeUndefined();
 });

 it('revalidates before each MAX retry: a replaced screen does not make another API send',async()=>{
  await page(4);const worker=new MaxMessageService(h.services.max,{prisma:db,storage:h.services.media as never});
  const api=vi.spyOn(h.services.max.api,'sendMessageToUser').mockImplementation(async()=>{
   await h.services.sessions.clear(USER,USER);throw new MaxError(503,{code:'unavailable',message:'synthetic'});
  });
  sendHook=(t:any,m:any)=>m.immediatePreview?worker.send(t,m):Promise.resolve();
  await click('Иное');expect(api).toHaveBeenCalledTimes(1);expect(await session()).toBeNull();worker.stop();await worker.waitForIdle();
 });

 it('lost MAX responses may duplicate the screen, but cannot register before explicit confirmed delivery or twice',async()=>{
  await page(4);await click('Иное');const d=await data();const ix=d.screenActions.findIndex((x:string)=>x.endsWith('~KALUGA_CITY'));await press(buttons().find((b:any)=>b.payload?.endsWith('~'+ix)).payload);
  const accepted:any[]=[];const worker=new MaxMessageService(h.services.max,{prisma:db,storage:h.services.media as never});
  vi.spyOn(h.services.max.api,'sendMessageToUser').mockImplementation(async(_id:any,_text:any,extra:any)=>{
   accepted.push(extra.attachments.find((a:any)=>a.type==='inline_keyboard').payload.buttons);
   throw new MaxError(503,{code:'unavailable',message:'response lost after acceptance'});
  });
  sendHook=(t:any,m:any)=>m.immediatePreview?worker.send(t,m):Promise.resolve();
  await type('Яма у дома 12');sendHook=undefined;expect(accepted).toHaveLength(4);expect(await db.incident.count()).toBe(0);
  const confirm=accepted[0].flat().find((b:any)=>b.text==='✅ Всё верно').payload;
  await press(confirm);expect(await db.incident.count()).toBe(0);expect((await data()).draftScreenDelivery).toBeTruthy();
  await recover();const valid=button('✅ Всё верно');await press(valid);await press(valid);expect(await db.incident.count()).toBe(1);
  const sends=h.messages.sent.length;await new DraftScreenRecovery(h.services).tick();expect(h.messages.sent).toHaveLength(sends);
  worker.stop();await worker.waitForIdle();
 });


 it('a superseded delivery lease cannot send again or overwrite the newer attempt',async()=>{
  await page(0);sendHook=async()=>{throw new MaxError(503,{code:'unavailable',message:'synthetic'})};await click('Вперёд ➡️');sendHook=undefined;
  const old=await session();
  const sending={...old.data,draftScreenDelivery:{...old.data.draftScreenDelivery,status:'sending',nextAttemptAt:0}};
  const newer={...sending,draftScreenDelivery:{...sending.draftScreenDelivery,attempts:3,nextAttemptAt:Date.now()+300000}};
  await db.operatorSession.update({where:{id:old.id},data:{data:newer}});
  const sends=h.messages.sent.length;
  await deliverSavedScreen(h.services,{...old,data:sending});
  expect(await data()).toEqual(newer);expect(h.messages.sent).toHaveLength(sends);
 });

 it('discards a mismatched persisted job without sending or starving the current screen',async()=>{
  await page(0);sendHook=async()=>{throw new MaxError(503,{code:'unavailable',message:'synthetic'})};await click('Вперёд ➡️');sendHook=undefined;
  const old=(await data()).draftScreenDelivery;
  await press('user:menu');await press('user:new');await click('Продолжить черновик');
  const current=await session();await db.operatorSession.update({where:{id:current.id},data:{data:{...current.data,draftScreenDelivery:{...old,nextAttemptAt:0}}}});
  const sends=h.messages.sent.length;await new DraftScreenRecovery(h.services).tick();
  expect((await data()).draftScreenDelivery).toBeUndefined();expect((await data()).screenToken).toBe(current.data.screenToken);expect(h.messages.sent).toHaveLength(sends);
  for(let i=0;i<4;i++)await click('Вперёд ➡️');await click('Иное');await finish();
 });

});
