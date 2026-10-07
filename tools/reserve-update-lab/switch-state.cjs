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
  const preserved = async () => {
    const tables = ['User','ResponsibleGroup','Incident','IncidentAttachment','IncidentAnswer','IncidentHistory','OperatorSession','OutboundMessage','InboundUpdate'];
    const rows = {};
    for (const table of tables) rows[table] = await p.$queryRawUnsafe(`SELECT to_jsonb(t) - ARRAY['slaPolicy','slaDeliveredAt','workingDeadlineQueuedAt','cancelledAt','cancelReason'] AS row FROM "${table}" t WHERE id LIKE 'preserved-%' ORDER BY id`);
    return {rows, bytes:hash(fs.readFileSync('/app/data/uploads/preserved.txt'))};
  };
  if(input.op==='switch-seed-installed') {
    await p.$executeRawUnsafe(`INSERT INTO "User" (id,"maxUserId","displayName","updatedAt") VALUES ('preserved-user',99001,'Synthetic',now())`);
    await p.$executeRawUnsafe(`INSERT INTO "ResponsibleGroup" (id,code,name,kind,"maxChatId","isActive","updatedAt") VALUES ('preserved-group','preserved-group','Synthetic preserved group','REGIONAL',-99009,false,now())`);
    await p.$executeRawUnsafe(`INSERT INTO "Incident" (id,"publicCode","requesterId","requesterMaxUserId","requesterName","requesterPhone",text,status,"assignedGroupId","assignedByUserId","deadlineAt","updatedAt") VALUES ('preserved-incident','INC-PRESERVED','preserved-user',99001,'Synthetic','+79000000000','Synthetic preservation','ASSIGNED','preserved-group','preserved-user','2099-01-01',now())`);
    await p.$executeRawUnsafe(`INSERT INTO "IncidentHistory" (id,"incidentId",action,"fromStatus","toStatus","actorMaxUserId") VALUES ('preserved-history','preserved-incident','ASSIGNED','DISTRIBUTION','ASSIGNED',99001)`);
    await p.$executeRawUnsafe(`INSERT INTO "IncidentAttachment" (id,"incidentId",type,"storageKey",size) VALUES ('preserved-attachment','preserved-incident','FILE','preserved.txt',15)`);
    await p.$executeRawUnsafe(`INSERT INTO "IncidentAnswer" (id,"incidentId",version,text,status,"createdByUserId","updatedAt") VALUES ('preserved-answer','preserved-incident',1,'Synthetic pending answer','DRAFT','preserved-user',now())`);
    fs.writeFileSync('/app/data/uploads/preserved.txt','synthetic bytes');
    await p.operatorSession.create({data:{id:'preserved-draft',maxUserId:99001n,chatId:99001n,type:'WAITING_INCIDENT_CONFIRMATION',expiresAt:new Date('2099-01-01'),data:{draftText:'Synthetic draft',requesterPhone:'+79000000000',draftMedia:[{storageKey:'preserved.txt',kind:'FILE'}],draftToken:'synthetic-draft-token',screenToken:'synthetic-screen-token',previewToken:'synthetic-preview-token',selectedCategoryId:null,problemMunicipalityCode:'SYNTHETIC',problemMunicipalityName:'Synthetic place',inputStartedAt:Date.now()}}});
    for(let n=0;n<8;n++) await p.$executeRawUnsafe(`INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"lastError",attempts,"updatedAt") VALUES ('preserved-failed-${n}','chat',${-99000-n},'{"text":"Synthetic terminal"}','[]','FAILED','${n<6?'MANUALLY_RETIRED_FOREIGN_BOT_ADDED':'MAX_HTTP_403'}',12,now())`);
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
  if(input.op==='switch-bulk-probe') {
    const count=20000; let error=null;
    const began=performance.now();
    try {
      await p.$executeRawUnsafe(`INSERT INTO "InboundUpdate" (id,"externalUpdateKey","updateType","partitionKey",payload,status,"updatedAt") SELECT 'bulk-probe-'||n,'bulk-probe-'||n,'synthetic_noop','user:'||n,jsonb_build_object('storageKey','bulk-key-'||n||'.txt'),'PROCESSED',now() FROM generate_series(1,20000) n`);
    } catch(e) {error={code:e.code,sqlstate:e.meta?.code,message:e.meta?.message};}
    const rows=await p.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "InboundUpdate" WHERE id LIKE 'bulk-probe-%'`);
    const expected=input.guarded ? 0 : count;
    assert.equal(rows[0].count,expected);
    if(input.guarded) assert.equal(error?.sqlstate,'53200'); else assert.equal(error,null);
    await p.$executeRawUnsafe(`DELETE FROM "InboundUpdate" WHERE id LIKE 'bulk-probe-%'`);
    return {guarded:input.guarded,count,insertedBeforeCleanup:rows[0].count,error,elapsedMs:performance.now()-began,settings:await p.$queryRawUnsafe(`SELECT name,setting FROM pg_settings WHERE name IN ('max_locks_per_transaction','max_connections','max_prepared_transactions')`)};
  }
  if(input.op==='benchmark') {
    // App containers have exited. Snapshot evidence was saved before this synthetic load.
    const {drainFileDeletions,queueFileDeletion}=req('/app/dist/retention/file-deletions');
    // Bounded fixture transactions. The separate unchanged bulk probe records
    // the trigger lock-budget regression; this does not raise database limits.
    for(let first=1;first<=20000;first+=250) await p.$executeRawUnsafe(`INSERT INTO "InboundUpdate" (id,"externalUpdateKey","updateType","partitionKey",payload,status,"updatedAt") SELECT 'load-in-'||n,'load-in-'||n,'synthetic_noop','user:'||n,jsonb_build_object('storageKey','historic-in-'||n||'.txt'),'PROCESSED',now() FROM generate_series(${first},${first+249}) n`);
    for(let first=1;first<=25000;first+=250) await p.$executeRawUnsafe(`INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"updatedAt") SELECT 'load-out-'||n,'user',n,jsonb_build_object('text','synthetic','storageKey','historic-out-'||n||'.txt'),'[]','SENT',now() FROM generate_series(${first},${first+249}) n`);
    await p.$executeRawUnsafe(`INSERT INTO "Incident" (id,"publicCode","requesterId","requesterMaxUserId","requesterName",text,status,"deadlineAt","updatedAt") SELECT 'bench-incident-'||n,'INC-BENCH-'||n,'preserved-user',99001,'Synthetic','Synthetic benchmark','ASSIGNED',now()+interval '3 days',now() FROM generate_series(1,500) n`);
    await p.$executeRawUnsafe(`INSERT INTO "IncidentAttachment" (id,"incidentId",type,"storageKey") SELECT 'bench-attachment-'||n,'bench-incident-'||n,'FILE','synthetic-shared-'||n||'.txt' FROM generate_series(1,500) n`);
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
    const beganDelete=performance.now();
    const deleting=drainFileDeletions(p,{remove:async()=>{entered.resolve();await release.promise;}},{removeTimeoutMs:5000}).then(r=>{settled=true;return r});
    await entered.promise; const referenceCheckMs=performance.now()-beganDelete;
    try {
      await measure('slow-delete');
      assert.equal(settled,false,'concurrent writes must complete while storage request is still held');
      const locks=await p.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_locks WHERE mode='ShareRowExclusiveLock' AND granted AND relation IN (SELECT oid FROM pg_class WHERE relname IN ('InboundUpdate','OutboundMessage'))`);
      assert.equal(locks[0].count,0);
    } finally {release.resolve();}
    const result=await deleting; assert.equal(result.deletedFiles,1);
    return {syntheticVolume:{inbox:20000,outbox:25000,incidents:500,attachments:500},concurrentUsers:8,writesPerPhase:640,referenceCheckMs,measurements,deleteResult:result,scope:'DB durable admission only, excludes MAX/network/user-device latency; single runner, no production performance guarantee'};
  }
  throw Error('Unknown switch operation');
};
