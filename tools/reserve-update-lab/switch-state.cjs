'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const intent = k => 'retention.file-delete.v1:' + hash(k);
const fence = k => 'retention.file-fence.v1:' + hash(k);
const state = k => 'retention.file-state.v1:' + hash(k);
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
  throw Error('Unknown switch operation');
};
