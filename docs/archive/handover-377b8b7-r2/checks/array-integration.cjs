'use strict';
const assert=require('node:assert/strict');
const req=require('node:module').createRequire('/app/package.json');
const {PrismaClient}=req('@prisma/client'),db=new PrismaClient({log:[]});
const {plan,apply,finish}=require('/ops/cleanup-test-data.cjs');
const {json}=require('/ops/common.cjs');
if(new URL(process.env.DATABASE_URL).pathname!=='/incident_tools_r2_test')throw Error('Isolated DB only');
(async()=>{
 const user=await db.user.findFirstOrThrow();
 const incident=await db.incident.create({data:{publicCode:'INC-000165',requesterId:user.id,requesterMaxUserId:555n,requesterName:'Synthetic',text:'Synthetic',deadlineAt:new Date('2099-01-01')}});
 const task=await db.outboundMessage.create({data:{targetType:'chat',targetId:-900n,incidentId:incident.id,payload:{operation:{type:'distribution-refresh',incidentId:incident.id,messageIds:['mid.array-only','panel-0']}},attachments:[]}});
 const p=await plan(db);assert.deepEqual(p.messageIds,['mid.array-only']);assert(p.outboxIds.includes(task.id));
 assert.equal(await db.outboundMessage.count({where:{id:task.id}}),1);
 let journalCheckedBeforeDeletion=false;
 const instrumented={$transaction:(fn,options)=>db.$transaction(tx=>fn(new Proxy(tx,{get(target,key){
  if(key==='outboundMessage')return new Proxy(target.outboundMessage,{get(model,method){
   if(method==='deleteMany')return async args=>{
    const row=await tx.systemSetting.findUniqueOrThrow({where:{key:`maintenance.package-cleanup:${p.fingerprint}`}});
    assert(JSON.parse(row.value).remainingMessages.includes('mid.array-only'));
    assert.equal(await tx.outboundMessage.count({where:{id:task.id}}),1);
    journalCheckedBeforeDeletion=true;return model.deleteMany(args);
   };
   const value=model[method];return typeof value==='function'?value.bind(model):value;
  }});
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }})),options)};
 let journal=await apply(instrumented,p);assert(journalCheckedBeforeDeletion);
 assert.equal(await db.outboundMessage.count({where:{id:task.id}}),0);
 assert.equal(await db.systemSetting.count({where:{key:{startsWith:'work-panel:'}}}),54);
 const persist=j=>db.systemSetting.update({where:{key:j.key},data:{value:json(j)}});
 const reload=async()=>JSON.parse((await db.systemSetting.findUniqueOrThrow({where:{key:journal.key}})).value);
 let mode='get404',deletes=0;
 const max={me:async()=>({user_id:777}),get:async()=>{
  if(mode==='get404')throw Object.assign(Error('secret should not appear'),{safeCode:'MAX_HTTP_404'});
  return{sender:{user_id:777,is_bot:true},body:{text:'Synthetic'}};
 },remove:async()=>{deletes++;if(mode==='delete404')throw Object.assign(Error('private'),{safeCode:'MAX_HTTP_404'});return{success:true}}};
 await finish(db,journal,max,{},persist);journal=await reload();assert.deepEqual(journal.remainingMessages,['mid.array-only']);assert.equal(deletes,0);
 await finish(db,journal,max,{},persist);journal=await reload();assert.deepEqual(journal.remainingMessages,['mid.array-only']);assert.equal(deletes,0);
 mode='delete404';await finish(db,journal,max,{},persist);journal=await reload();assert.deepEqual(journal.remainingMessages,['mid.array-only']);
 mode='get404';await finish(db,journal,max,{},persist);journal=await reload();assert.deepEqual(journal.remainingMessages,['mid.array-only']);assert.equal(deletes,1);
 mode='success';await finish(db,journal,max,{},persist);journal=await reload();assert.deepEqual(journal.remainingMessages,[]);assert.equal(deletes,2);
 await finish(db,journal,max,{},persist);assert.equal(deletes,2);
 assert.equal(journal.messageResults['mid.array-only'].outcome,'deleted-confirmed');
 assert(!json(journal).includes('secret should not appear'));
 console.log(JSON.stringify({arrayOnlyIdInPlan:true,journalCheckedBeforeOutboxDeletion:journalCheckedBeforeDeletion,persistentGet404Retained:true,delete404AndLaterGet404Retained:true,retryConfirmedOnlyBySuccessTrue:true,idempotentFinishedRetry:true,protectedPanels:54,realMaxCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
