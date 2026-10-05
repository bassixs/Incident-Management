'use strict';
const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const app=path.resolve(process.env.FIXTURE_APP||'.fixture-app');
const {createRequire}=require('node:module');const ar=createRequire(path.join(app,'package.json'));
ar('tsx/cjs');
const {PrismaClient}=ar('@prisma/client');
const {getConfig,resetConfigForTests}=ar('./src/config');
const {PinnedPanelService,isOwnQueuePanel}=ar('./src/max/pinned-panel.service');
const {workPanelText,workButtons,queueWorkPanel}=ar('./src/work-queues/state');
const {MaxMessageService}=ar('./src/max/max-message.service');
const {PanelSwap,Journal,REV,encode}=require('../panel-swap.cjs');
const u=new URL(process.env.DATABASE_URL);
assert.equal(u.pathname,'/panel_swap_lab');assert.ok(['127.0.0.1','localhost'].includes(u.hostname));
const db=new PrismaClient(); const db2=new PrismaClient();
let dir,j,max,op,e,worker,seq,rows,pin,posts,edits,failSend,hideHistory,failEdit;
const chat=-1002n,key='work-panel:-1002',old='mid.synthetic-old';
const clone=x=>structuredClone(x);
const message=(id,text,buttons=[])=>({sender:{user_id:777,is_bot:true},recipient:{chat_id:Number(chat)},timestamp:Date.now(),
 body:{mid:id,text,attachments:buttons.length?[{type:'inline_keyboard',payload:{buttons}}]:[]}});
function make(client=db) { return new PanelSwap({db:client,max,journal:j,expected:e,own:isOwnQueuePanel,text:workPanelText,buttons:workButtons}); }
async function outside() {
 const tables=await db.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
 const all={};
 for(const {table_name:n} of tables) {
  let r=await db.$queryRawUnsafe('SELECT row_to_json(t) AS row FROM "'+n.replaceAll('"','""')+'" t');
  if(n==='SystemSetting')r=r.filter(x=>x.row.key!==key);
  if(n==='OutboundMessage')r=r.filter(x=>x.row.id!==e.jobId);
  all[n]=r.map(x=>encode(x.row)).sort();
 }
 return encode(all);
}
async function cycle() { await queueWorkPanel(db,chat); await worker.flush(); await worker.waitForIdle(); }
async function stage() {await op.prepare();await op.send();return j.read().newMid;}
async function refs() {const r=await op.read();return [r.setting.value,r.job.firstMessageId];}
before(async()=>{ await db.$connect();await db2.$connect(); });
after(async()=>{await db.$disconnect();await db2.$disconnect();});
beforeEach(async()=>{
 // Exclusive synthetic DB only. No production URLs/tokens are accepted above.
 const tables=await db.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name<>'_prisma_migrations'");
 await db.$executeRawUnsafe('TRUNCATE '+tables.map(x=>'"'+x.table_name+'"').join(',')+' RESTART IDENTITY CASCADE');
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'panel-swap-'));fs.chmodSync(dir,0o700);j=new Journal(dir);
 seq=0;posts=0;edits=[];failSend=false;hideHistory=false;failEdit=false;pin=old;rows=new Map();
 const user=await db.user.create({data:{maxUserId:12345n,displayName:'Synthetic resident'}});
 const incident=await db.incident.create({data:{publicCode:'SYN-001',requesterId:user.id,requesterMaxUserId:12345n,requesterName:'Synthetic',text:'Synthetic test content',deadlineAt:new Date(Date.now()+86400000),status:'WAITING_REVIEW'}});
 await db.incidentHistory.create({data:{incidentId:incident.id,action:'SYNTHETIC',metadata:{keep:true}}});
 await db.incidentCounter.create({data:{day:'global',lastNumber:999}});
 await db.systemSetting.createMany({data:[{key,value:old},{key:'work-panel:-999',value:'mid.other-panel'},{key:'keep-setting',value:'unchanged'}]});
 const job=await db.outboundMessage.create({data:{dedupeKey:key,targetType:'chat',targetId:chat,payload:{text:'Очередь сообщений',operation:{type:'work-panel'}},attachments:[],status:'SENT',trackingApplied:true,firstMessageId:old,sentAt:new Date(0)}});
 await db.outboundMessage.create({data:{dedupeKey:'keep-failed',targetType:'user',targetId:12345n,payload:{text:'Synthetic undelivered'},attachments:[],status:'FAILED',lastError:'KEEP_FAILED',incidentId:incident.id}});
 e={revision:REV,chatId:String(chat),oldMid:old,jobId:job.id,database:'panel_swap_lab'};
 rows.set(old,message(old,await workPanelText(db,chat),workButtons()));
 max={me:async()=>({user_id:777}),get:async id=>{assert.ok(rows.has(id),'MOCK_MISSING');return clone(rows.get(id));},
  pin:async()=>clone(rows.get(pin)),history:async before=>({messages:hideHistory?[]:[...rows.values()].filter(x=>x.timestamp<=before).sort((a,b)=>b.timestamp-a.timestamp).slice(0,100).map(clone)}),
  send:async text=>{posts++;const m=message('mid.synthetic-new-'+(++seq),text);rows.set(m.body.mid,m);if(failSend)throw Error('SIMULATED_LOST_ACK');return clone(m);}};
 const client={getMe:max.me,getMessage:max.get,getPinnedMessage:async()=>({message:await max.pin()}),getChatMessages:async(_c,b)=>max.history(b),
  sendPanelOnce:async()=>{throw Error('WORKER_MUST_NOT_CREATE_ANOTHER_PANEL');},
  editMessage:async(id,text,attachments)=>{if(failEdit)throw Error('SIMULATED_EDIT_FAILURE');edits.push(id);rows.get(id).body={mid:id,text,attachments};},
  pinMessage:async(c,id)=>{assert.equal(c,chat);pin=id;return {success:true};}};
 worker=new MaxMessageService(client,{prisma:db,storage:{remove:async()=>{throw Error('NO_ATTACHMENT_CLEANUP');}}},1);
 op=make();
});
afterEach(async()=>{worker.stop();await worker.waitForIdle();fs.rmSync(dir,{recursive:true});});

test('atomic two-link swap and two ordinary 8dcfa330 worker cycles; all other DB data unchanged',async()=>{
 const before=await outside();const id=await stage();assert.equal(posts,1);assert.deepEqual(rows.get(id).body.attachments,[]);assert.equal(pin,old);
 const original=(await op.read()).job; await op.swap(); assert.deepEqual(await refs(),[id,id]);
 const swapped=(await op.read()).job;
 for(const k of Object.keys(original))if(!['firstMessageId','updatedAt'].includes(k))assert.equal(encode(swapped[k]),encode(original[k]),k);
 await cycle();assert.equal(pin,id);assert.deepEqual(rows.get(id).body.attachments[0].payload.buttons,workButtons());
 assert.equal((await op.observe()).ready,false);await cycle();assert.equal((await op.observe()).ready,true);
 assert.equal(posts,1);assert.ok(edits.every(x=>x===id));assert.deepEqual(rows.get(old).body.attachments[0].payload.buttons,workButtons());
 assert.equal(await outside(),before);
});
test('SENDING job refused without changing either reference',async()=>{
 const id=await stage();await db.outboundMessage.update({where:{id:e.jobId},data:{status:'SENDING',lockedAt:new Date()}});
 const before=await outside();await assert.rejects(op.swap(),/JOB_NOT_IDLE/);assert.deepEqual(await refs(),[old,old]);assert.equal(posts,1);assert.equal(await outside(),before);
});
for(const status of ['PENDING','FAILED'])test(status+' job refused',async()=>{
 await stage();await db.outboundMessage.update({where:{id:e.jobId},data:{status}});await assert.rejects(op.swap(),/JOB_NOT_IDLE/);assert.deepEqual(await refs(),[old,old]);
});
test('NOWAIT refuses real concurrent row lock; reconciliation then safe explicit retry',async()=>{
 const id=await stage();let unlock,acquired;const got=new Promise(r=>acquired=r);const hold=new Promise(r=>unlock=r);
 const holding=db2.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT id FROM "OutboundMessage" WHERE id=$1 FOR UPDATE',e.jobId);acquired();await hold;},{timeout:10000});
 await got;try{await assert.rejects(op.swap());assert.deepEqual(await refs(),[old,old]);assert.equal(j.read().phase,'switch-intent');}finally{unlock();await holding;}
 assert.equal((await op.reconcile()).phase,'staged');await op.swap();assert.deepEqual(await refs(),[id,id]);assert.equal(posts,1);
});
test('changed setting refuses swap',async()=>{await stage();await db.systemSetting.update({where:{key},data:{value:'mid.changed'}});await assert.rejects(op.swap(),/REFERENCES_CHANGED/);assert.deepEqual(await refs(),['mid.changed',old]);});
test('changed job MID refuses swap',async()=>{await stage();await db.outboundMessage.update({where:{id:e.jobId},data:{firstMessageId:'mid.changed'}});await assert.rejects(op.swap(),/REFERENCES_CHANGED/);assert.deepEqual(await refs(),[old,'mid.changed']);});
test('changed job payload and recovery refuse swap',async()=>{
 await stage();await db.outboundMessage.update({where:{id:e.jobId},data:{payload:{operation:{type:'work-panel'},text:'Changed'}}});await assert.rejects(op.swap(),/JOB_CHANGED/);
});
test('recovery state refuses swap',async()=>{await stage();await db.systemSetting.create({data:{key:'panel-recovery:'+key,value:'{}'}});await assert.rejects(op.swap(),/RECOVERY_STATE_PRESENT/);});
test('accepted POST lost ACK reconciles after tool restart without second POST',async()=>{
 const before=await outside();await op.prepare();failSend=true;await assert.rejects(op.send(),/SIMULATED_LOST_ACK/);assert.equal(j.read().phase,'send-intent');
 op=make();await assert.rejects(op.send(),/SEND_ALREADY_ATTEMPTED/);const r=await op.reconcile();assert.equal(r.phase,'staged');assert.equal(posts,1);await op.swap();await cycle();assert.equal(pin,r.newMid);assert.equal(await outside(),before);
});
test('unknown POST not visible remains unknown; no blind resend',async()=>{
 await op.prepare();failSend=true;await assert.rejects(op.send());hideHistory=true;await assert.rejects(op.reconcile(),/SEND_OUTCOME_UNKNOWN/);await assert.rejects(op.send(),/SEND_ALREADY_ATTEMPTED/);assert.equal(posts,1);assert.deepEqual(await refs(),[old,old]);
});
test('ambiguous two new history candidates refuses adoption',async()=>{
 await op.prepare();failSend=true;await assert.rejects(op.send());const s=j.read();rows.set('mid.ambiguous',message('mid.ambiguous',s.text));await assert.rejects(op.reconcile(),/AMBIGUOUS_SEND/);assert.deepEqual(await refs(),[old,old]);assert.equal(posts,1);
});
function commitFault(commit) {
 let armed=true;return new Proxy(db,{get(t,k){if(k==='$transaction')return async(fn,opts)=>{
  if(!armed || opts?.timeout!==4000)return t.$transaction(fn,opts);
  armed=false;if(commit){await t.$transaction(fn,opts);throw Error('LOST_COMMIT_ACK');}
  return t.$transaction(async tx=>{await fn(tx);throw Error('BEFORE_COMMIT_DISCONNECT');},opts);
 };const v=t[k];return typeof v==='function'?v.bind(t):v;}});
}
test('COMMIT persisted but ACK lost: read-only reconciliation, no resend',async()=>{
 const before=await outside();const id=await stage();op=make(commitFault(true));await assert.rejects(op.swap(),/LOST_COMMIT_ACK/);assert.equal(j.read().phase,'switch-intent');
 op=make();await assert.rejects(op.swap(),/INVALID_PHASE/);await assert.rejects(op.send(),/SEND_ALREADY_ATTEMPTED/);
 assert.equal((await op.reconcile()).phase,'switched');assert.deepEqual(await refs(),[id,id]);await cycle();assert.equal(posts,1);assert.equal(await outside(),before);
});
test('transaction lost before commit rolls back both links; explicit retry reuses MID',async()=>{
 const id=await stage();op=make(commitFault(false));await assert.rejects(op.swap(),/BEFORE_COMMIT_DISCONNECT/);assert.deepEqual(await refs(),[old,old]);
 op=make();assert.equal((await op.reconcile()).phase,'staged');await op.swap();assert.deepEqual(await refs(),[id,id]);assert.equal(posts,1);
});
test('protected rollback restores two links, ordinary worker repins old, outside unchanged',async()=>{
 const before=await outside();await stage();await op.swap();await cycle();await op.swap(true);assert.deepEqual(await refs(),[old,old]);await cycle();assert.equal(pin,old);await op.observe();await cycle();assert.equal((await op.observe()).ready,true);assert.equal(j.read().phase,'rollback-verified');assert.equal(posts,1);assert.equal(await outside(),before);
});
test('rollback refuses running job and altered references',async()=>{
 await stage();await op.swap();await db.outboundMessage.update({where:{id:e.jobId},data:{status:'SENDING',lockedAt:new Date()}});await assert.rejects(op.swap(true),/JOB_NOT_IDLE/);
 await db.outboundMessage.update({where:{id:e.jobId},data:{status:'SENT',lockedAt:null,firstMessageId:'mid.changed'}});await assert.rejects(op.swap(true),/REFERENCES_CHANGED/);
});
test('rollback lost ACK reconciles to old without another send or write',async()=>{
 await stage();await op.swap();op=make(commitFault(true));await assert.rejects(op.swap(true),/LOST_COMMIT_ACK/);op=make();assert.equal((await op.reconcile()).phase,'rolled-back');assert.deepEqual(await refs(),[old,old]);assert.equal(posts,1);
});
test('double prepare/send/switch refused, journal lock and incomplete write refuse',async()=>{
 await stage();await assert.rejects(op.prepare(),/JOURNAL_EXISTS/);await assert.rejects(op.send(),/SEND_ALREADY_ATTEMPTED/);await op.swap();await assert.rejects(op.swap(),/INVALID_PHASE/);
 const release=j.lock();try{assert.throws(()=>j.lock(),/OPERATION_LOCKED/);}finally{release();}j.lock()();
 fs.writeFileSync(j.file+'.next','incomplete');await assert.rejects(op.swap(true));assert.deepEqual(await refs(),[j.read().newMid,j.read().newMid]);
});
test('ordinary worker failure does not make observe successful or send another panel',async()=>{
 await stage();await op.swap();failEdit=true;await cycle();await assert.rejects(op.observe(),/JOB_NOT_IDLE/);assert.equal(pin,old);assert.equal(posts,1);assert.equal((await op.read()).job.status,'PENDING');
});
