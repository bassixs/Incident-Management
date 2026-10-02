const {createRequire}=require('node:module');const req=createRequire('/app/package.json');
const assert=require('node:assert/strict'),fs=require('node:fs');
const {PrismaClient}=req('@prisma/client');const db=new PrismaClient({log:[]});
const {plan,apply,finish}=require('/ops/cleanup-test-data.cjs');
const {snapshot}=require('/ops/snapshot.cjs');const {json}=require('/ops/common.cjs');
if(new URL(process.env.DATABASE_URL).pathname!=='/incident_tools_r2_test')throw Error('Isolated DB only');
(async()=>{
 if(process.argv[2]==='seed'){
  const user=await db.user.create({data:{maxUserId:555n,displayName:'Synthetic',roles:['REQUESTER']}});
  const category=await db.category.create({data:{code:'TEST',name:'Test'}});
  const group=await db.responsibleGroup.create({data:{code:'TEST',name:'Test',kind:'REGIONAL',isActive:false,maxChatId:-900n}});
  const incident=await db.incident.create({data:{publicCode:'INC-000164',requesterId:user.id,requesterMaxUserId:555n,requesterName:'Resident',text:'Synthetic issue',deadlineAt:new Date('2099-01-01'),distributionMessageId:'card-164',userSelectedCategoryId:category.id,assignedGroupId:group.id,attachments:{create:[{type:'IMAGE',storageKey:'test/photo.bin'},{type:'IMAGE',storageKey:'test/shared.bin'}]},answers:{create:{version:1,text:'Test answer',createdByUserId:user.id,attachments:{create:{type:'FILE',storageKey:'test/answer.bin'}}}},history:{create:{action:'TEST',metadata:{messageId:'panel-0'}}}}});
  await db.incidentCounter.create({data:{day:'global',lastNumber:164}});
  await db.systemSetting.createMany({data:Array.from({length:54},(_,i)=>({key:`work-panel:${-900-i}`,value:`panel-${i}`}))});
  await db.systemSetting.create({data:{key:'business-setting',value:'preserved'}});
  await db.operatorSession.create({data:{maxUserId:555n,chatId:555n,type:'WAITING_INCIDENT_CONFIRMATION',expiresAt:new Date('2099-01-01'),data:{draftToken:'11111111-1111-4111-8111-111111111111',previewMessageId:'draft-card',draftText:'Test draft'}}});
  await db.privateWorkItem.create({data:{maxUserId:555n,incidentId:incident.id,originChatId:-900n}});
  await db.actionLock.create({data:{key:'test-lock',maxUserId:555n,incidentId:incident.id,action:'test',lockedUntil:new Date('2099-01-01')}});
  await db.outboundMessage.createMany({data:[
   {targetType:'chat',targetId:-900n,incidentId:incident.id,payload:{text:'INC-000164',operation:{type:'sector-refresh',incidentId:incident.id}},attachments:[],firstMessageId:'copy-164'},
   {targetType:'chat',targetId:-900n,payload:{text:'Lookup INC-000164'},attachments:[],firstMessageId:'lookup-164'},
   {targetType:'chat',targetId:-900n,payload:{operation:{type:'work-panel'}},attachments:[],dedupeKey:'work-panel:-900',status:'SENT'},
   {targetType:'user',targetId:556n,payload:{text:'Unrelated'},attachments:[{storageKey:'test/shared.bin',type:'IMAGE'}],status:'SENT'},
   {targetType:'user',targetId:556n,payload:{operation:{type:'bot-status'}},attachments:[],status:'SENT'}]});
  await db.inboundUpdate.createMany({data:[{externalUpdateKey:'old-callback',updateType:'message_callback',payload:{callback:{payload:`inc:${incident.id}:view`}}},{externalUpdateKey:'draft-input',updateType:'message_created',payload:{message:{sender:{user_id:555},recipient:{chat_id:555},body:{text:'synthetic'}}}},{externalUpdateKey:'service',updateType:'user_added',payload:{user:{user_id:999}},status:'PROCESSED'}]});
  fs.mkdirSync('/app/data/uploads/test',{recursive:true});for(const f of ['photo','answer','shared'])fs.writeFileSync(`/app/data/uploads/test/${f}.bin`,f);
  console.log('Seeded synthetic data, 54 panels, queues and attachments');return;
 }
 const before=await snapshot(db,false),p=await plan(db);const after=await snapshot(db,false);
 assert.deepEqual(before.database,after.database);assert.deepEqual(before.queues,after.queues);
 assert.equal(p.counts.incidents,1);assert.equal(p.counts.drafts,1);assert.equal(p.counts.outbox,2);assert.equal(p.counts.inbox,2);
 assert(!p.messageIds.includes('panel-0'));assert(!p.fileKeys.includes('test/shared.bin'));
 await db.incident.updateMany({data:{text:'Changed'}});await assert.rejects(apply(db,p));assert.equal(await db.incident.count(),1);
 await db.inboundUpdate.create({data:{externalUpdateKey:'unknown',updateType:'message_created',payload:{message:{sender:{user_id:888}}}}});
 const blocked=await plan(db);assert.equal(blocked.blockers.length,1);await assert.rejects(apply(db,blocked));
 await db.inboundUpdate.update({where:{externalUpdateKey:'unknown'},data:{status:'PROCESSED'}});
 const current=await plan(db),journal=await apply(db,current);const retry=await apply(db,current);assert.equal(retry.key,journal.key);
 assert.equal(await db.incident.count(),0);assert.equal(await db.incidentAnswer.count(),0);assert.equal(await db.operatorSession.count(),0);assert.equal(await db.privateWorkItem.count(),0);assert.equal(await db.actionLock.count(),0);
 for(const model of ['user','category','responsibleGroup','incidentCounter'])assert.deepEqual((await snapshot(db,false)).database[model],before.database[model]);
 assert.equal(await db.systemSetting.count({where:{key:{startsWith:'work-panel:'}}}),54);
 assert.equal(await db.outboundMessage.count(),3);
 const tombstone=await db.inboundUpdate.findUniqueOrThrow({where:{externalUpdateKey:'old-callback'}});assert.equal(tombstone.status,'PROCESSED');assert.deepEqual(tombstone.payload,{});
 let fail=true;const removed=[];const storage={remove:async key=>{if(fail&&key==='test/answer.bin')throw Error('retry');fs.rmSync('/app/data/uploads/'+key,{force:true})}};
 const max={me:async()=>({user_id:777}),get:async mid=>({sender:{user_id:777,is_bot:true},body:{text:'Synthetic card'}}),remove:async mid=>{if(fail&&mid==='card-164')throw Error('MAX503');removed.push(mid);return {success:true}}};
 const persist=async j=>db.systemSetting.update({where:{key:j.key},data:{value:json(j)}});
 await finish(db,journal,max,storage,persist);assert(journal.remainingMessages.includes('card-164'));assert(journal.remainingFiles.includes('test/answer.bin'));
 fail=false;await finish(db,JSON.parse((await db.systemSetting.findUniqueOrThrow({where:{key:journal.key}})).value),max,storage,persist);
 const done=JSON.parse((await db.systemSetting.findUniqueOrThrow({where:{key:journal.key}})).value);assert.equal(done.remainingMessages.length,0);assert.equal(done.remainingFiles.length,0);assert(fs.existsSync('/app/data/uploads/test/shared.bin'));assert(!removed.includes('panel-0'));
 console.log(JSON.stringify({previewReadOnly:true,panelsPreserved:54,stalePlanRejected:true,unknownInboxBlocked:true,scopedQueues:true,inboxTombstones:true,usersGroupsCategoriesCounterPreserved:true,failedMaxDeletionRetried:true,sharedFilePreserved:true,remainingMessages:0,remainingFiles:0}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
