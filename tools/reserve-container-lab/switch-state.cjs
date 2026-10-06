'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const intent = k => 'retention.file-delete.v1:' + hash(k);
const fence = k => 'retention.file-fence.v1:' + hash(k);
const state = k => 'retention.file-state.v1:' + hash(k);
const barrier = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {resolve,promise}; };
module.exports = async function(p, input, req) {
  const preserved = async () => ({
    incident: await p.incident.findUniqueOrThrow({where:{id:'preserved-incident'},include:{attachments:true,answers:true,history:true}}),
    draft: await p.operatorSession.findUniqueOrThrow({where:{id:'preserved-draft'}}),
    failed: await p.outboundMessage.findMany({where:{id:{startsWith:'preserved-failed-'}},orderBy:{id:'asc'}}),
    bytes: hash(fs.readFileSync('/app/data/uploads/preserved.txt')),
  });
  if(input.op==='switch-seed-installed') {
    const user=await p.user.create({data:{id:'preserved-user',maxUserId:99001n,displayName:'Synthetic'}});
    await p.incident.create({data:{id:'preserved-incident',publicCode:'INC-PRESERVED',requesterId:user.id,requesterMaxUserId:99001n,requesterName:'Synthetic',text:'Synthetic preservation',status:'ASSIGNED',deadlineAt:new Date('2099-01-01'),
      attachments:{create:{id:'preserved-attachment',type:'FILE',storageKey:'preserved.txt',size:15}},
      answers:{create:{id:'preserved-answer',version:1,text:'Synthetic pending answer',status:'DRAFT',createdByUserId:user.id}},
    }});
    fs.writeFileSync('/app/data/uploads/preserved.txt','synthetic bytes');
    await p.operatorSession.create({data:{id:'preserved-draft',maxUserId:99001n,chatId:99001n,type:'WAITING_INCIDENT_CONFIRMATION',expiresAt:new Date('2099-01-01'),data:{draft:{text:'Synthetic draft',requesterPhone:'+79000000000',attachments:[{storageKey:'preserved.txt',type:'FILE'}]},draftScreenVersion:5}}});
    for(let n=0;n<8;n++) await p.outboundMessage.create({data:{id:'preserved-failed-'+n,targetType:'chat',targetId:BigInt(-99000-n),payload:{text:'Synthetic terminal'},attachments:[],status:'FAILED',lastError:n<6?'MANUALLY_RETIRED_FOREIGN_BOT_ADDED':'MAX_HTTP_403',attempts:12}});
    // Old schema: do not use a generated SELECT containing the new token column.
    await p.$executeRawUnsafe(`INSERT INTO "InboundUpdate" (id,"externalUpdateKey","updateType","partitionKey",payload,"nextAttemptAt","updatedAt") VALUES ('delayed-head','delayed-head','synthetic_noop','user:99002','{"update_type":"synthetic_noop"}','2099-01-01',now()),('delayed-tail','delayed-tail','synthetic_noop','user:99002','{"update_type":"synthetic_noop"}',now(),now())`);
    return preserved();
  }
  if(input.op==='switch-preserved') return preserved();
  if(input.op==='switch-seed-journal') {
    for(const k of ['pending-delete.txt','unknown-delete.txt']) {
      fs.writeFileSync('/app/data/uploads/'+k,'synthetic deletion');
      await p.systemSetting.create({data:{key:intent(k),value:JSON.stringify({version:1,storageKey:k,size:18,publicCode:'INC-SYNTHETIC'})}});
    }
    await p.systemSetting.create({data:{key:fence('unknown-delete.txt'),value:'PERMANENT_STORAGE_KEY_RETIREMENT_V1'}});
    await p.systemSetting.create({data:{key:state('unknown-delete.txt'),value:JSON.stringify({version:1,attempts:1,status:'unknown',nextAttemptAt:0,reason:'STORAGE_RESULT_UNKNOWN'})}});
    return true;
  }
  if(input.op==='switch-journal') return p.systemSetting.findMany({where:{key:{startsWith:'retention.file-'}},orderBy:{key:'asc'}});
  if(input.op==='switch-fence-rejected') {
    let failed=false;
    try { await p.outboundMessage.create({data:{id:'must-not-exist',targetType:'user',targetId:1n,payload:{text:'Synthetic forbidden reference'},attachments:[{storageKey:'unknown-delete.txt'}]}}); }
    catch(e) { failed=String(e).includes('STORAGE_KEY_RETIRED'); }
    assert(failed); assert.equal(await p.outboundMessage.count({where:{id:'must-not-exist'}}),0); return true;
  }
  if(input.op==='switch-inbox-pending') {
    const rows=await p.inboundUpdate.findMany({where:{id:{in:['delayed-head','delayed-tail']}}});
    return rows.length===2&&rows.every(r=>r.status==='PENDING'&&r.attempts===0);
  }
  if(input.op==='switch-inbox-due') return p.inboundUpdate.update({where:{id:'delayed-head'},data:{nextAttemptAt:new Date(0)}});
  if(input.op==='switch-inbox-done') {
    const rows=await p.inboundUpdate.findMany({where:{id:{in:['delayed-head','delayed-tail']}},orderBy:{sequence:'asc'}});
    return rows.length===2&&rows.every(r=>r.status==='PROCESSED'&&r.attempts===1)&&rows[0].processedAt<=rows[1].processedAt;
  }
  if(input.op==='switch-drain') {
    const {drainFileDeletions}=req('/app/dist/retention/file-deletions');
    const result=await drainFileDeletions(p,{remove:async k=>fs.promises.rm('/app/data/uploads/'+k,{force:true})});
    return {...result,unknownPreserved:fs.existsSync('/app/data/uploads/unknown-delete.txt')&&!!await p.systemSetting.findUnique({where:{key:intent('unknown-delete.txt')}}),fencesRetained:await p.systemSetting.count({where:{key:{in:[fence('unknown-delete.txt'),fence('pending-delete.txt')]}}})===2};
  }
  if(input.op==='benchmark') {
    // App containers have exited. A separate DB avoids affecting switching evidence.
    const {drainFileDeletions,queueFileDeletion}=req('/app/dist/retention/file-deletions');
    await p.$executeRawUnsafe(`INSERT INTO "InboundUpdate" (id,"externalUpdateKey","updateType","partitionKey",payload,status,"updatedAt") SELECT 'load-in-'||n,'load-in-'||n,'synthetic_noop','user:'||n,'{}','PROCESSED',now() FROM generate_series(1,20000) n`);
    await p.$executeRawUnsafe(`INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"updatedAt") SELECT 'load-out-'||n,'user',n,'{"text":"synthetic"}','[]','SENT',now() FROM generate_series(1,25000) n`);
    const guards=['IncidentAttachment','AnswerAttachment','ClarificationAttachment','OutboundMessage','OperatorSession','PrivateWorkItem','InboundUpdate'];
    const measurements=[];
    const measure=async label=>{
      const inbox=[],outbox=[]; const began=performance.now();
      await Promise.all(Array.from({length:8},async(_,u)=>{
        for(let i=0;i<40;i++) {
          const id=`${label}-${u}-${i}`, key=id+'.txt'; let t=performance.now();
          await p.inboundUpdate.create({data:{externalUpdateKey:id,partitionKey:'bench-user:'+u,updateType:'synthetic_noop',payload:{storageKey:key}}}); inbox.push(performance.now()-t);
          t=performance.now(); await p.outboundMessage.create({data:{targetType:'user',targetId:BigInt(30000+u),payload:{text:'synthetic',storageKey:key},attachments:[],status:'FAILED',lastError:'SYNTHETIC_BENCH_DO_NOT_SEND'}}); outbox.push(performance.now()-t);
        }
      }));
      const stats=a=>{a.sort((a,b)=>a-b);return{n:a.length,p50Ms:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)],maxMs:a.at(-1)}};
      const result={label,elapsedMs:performance.now()-began,inbox:stats(inbox),outbox:stats(outbox)}; measurements.push(result); return result;
    };
    // Isolated benchmark only: compare the same SQL/writers with and without guards.
    for(const table of guards) await p.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER guard_retired_storage`);
    try { await measure('unguarded'); } finally { for(const table of guards) await p.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER guard_retired_storage`); }
    await measure('guarded');
    const entered=barrier(),release=barrier();
    await p.$transaction(tx=>queueFileDeletion(tx,{storageKey:'bench-slow.txt',size:1,publicCode:'INC-BENCH'}));
    let settled=false;
    const deleting=drainFileDeletions(p,{remove:async()=>{entered.resolve();await release.promise;}},{removeTimeoutMs:5000}).then(r=>{settled=true;return r});
    await entered.promise;
    try {
      await measure('slow-delete');
      assert.equal(settled,false,'concurrent writes must complete while storage request is still held');
      const locks=await p.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_locks WHERE mode='ShareRowExclusiveLock' AND granted AND relation IN (SELECT oid FROM pg_class WHERE relname IN ('InboundUpdate','OutboundMessage'))`);
      assert.equal(locks[0].count,0);
    } finally {release.resolve();}
    const result=await deleting; assert.equal(result.deletedFiles,1);
    return {syntheticVolume:{inbox:20000,outbox:25000},concurrentUsers:8,writesPerPhase:640,measurements,deleteResult:result,scope:'DB durable admission only, excludes MAX/network/user-device latency; single runner, no production performance guarantee'};
  }
  throw Error('Unknown switch operation');
};
