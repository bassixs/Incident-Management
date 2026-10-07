'use strict';
const assert = require('node:assert/strict');
module.exports = async (p,input,req) => {
  const snapshot = async () => ({
    incident:await p.incident.findUniqueOrThrow({where:{id:'policy-incident'},include:{answers:{orderBy:{version:'asc'},include:{attachments:true}},attachments:{orderBy:{id:'asc'}},history:{orderBy:{id:'asc'}},assignmentCycles:{orderBy:{sequence:'asc'}}}}),
    draft:await p.operatorSession.findUniqueOrThrow({where:{id:'policy-draft'}}),
    private:await p.privateWorkItem.findUniqueOrThrow({where:{id:'policy-private'}}),
    screens:await p.systemSetting.findMany({where:{key:{startsWith:'synthetic-screen:'}},orderBy:{key:'asc'}}),
    deferred:await p.outboundMessage.findUniqueOrThrow({where:{id:'policy-future-deferred'}}),
    fences:await p.systemSetting.findMany({where:{key:{startsWith:'retention.file-'}},orderBy:{key:'asc'}}),
    legacy:await p.incident.findUniqueOrThrow({where:{id:'preserved-incident'}}),
  });
  if(input.op==='policy-cycle-count') return p.incidentAssignmentCycle.count();
  if(input.op==='policy-snapshot') return snapshot();
  if(input.op==='policy-card') return p.outboundMessage.create({data:{id:input.id,targetType:'chat',targetId:-88000n,payload:{text:'Synthetic ordinary card '+input.id},attachments:[]}});
  if(input.op==='policy-seed') {
    const {addWorkingHours}=req('/app/dist/sla/working-time');
    const {startAssignment,finishAssignment,recordPreparation}=req('/app/dist/sla/policy');
    assert.equal(req('/app/dist/config').getConfig().INCIDENT_SLA_POLICY,'WORKING_HOURS_V1');
    const at=new Date('2026-10-09T13:00:00Z');
    assert.equal(addWorkingHours(at,24).toISOString(),'2026-10-14T10:00:00.000Z');
    const i=await p.incident.create({data:{id:'policy-incident',publicCode:'INC-POLICY',requesterId:'preserved-user',requesterMaxUserId:99001n,requesterName:'Synthetic',requesterPhone:'+79000000000',text:'Synthetic original with nine photographs',status:'REVISION_REQUIRED',slaPolicy:'WORKING_HOURS_V1',assignedGroupId:'preserved-group',createdAt:at,deadlineAt:addWorkingHours(at,24),workingDeadlineQueuedAt:new Date('2026-10-16T13:59:00Z')}});
    const group={id:'preserved-group',code:'preserved-group',name:'Synthetic preserved group'};
    await p.$transaction(async tx=>{
      await startAssignment(tx,i,group,at);
      await finishAssignment(tx,i.id,new Date('2026-10-09T13:30:00Z'),'RETURNED','Synthetic reassign');
      await startAssignment(tx,i,group,new Date('2026-10-12T05:00:00Z'));
    });
    const cycles=await p.incidentAssignmentCycle.findMany({where:{incidentId:i.id},orderBy:{sequence:'asc'}});
    assert.equal(cycles.length,2);assert.equal(cycles[0].returnDueAt.toISOString(),'2026-10-12T06:00:00.000Z');
    assert.equal(cycles[1].preparationDueAt.toISOString(),'2026-10-14T09:00:00.000Z');
    for(let n=1;n<=8;n++) await p.incidentAnswer.create({data:{id:'policy-answer-'+n,incidentId:i.id,version:n,text:'Synthetic version '+n,revisionReason:n<8?'Synthetic remark '+n:null,status:n<8?'REVISION_REQUIRED':'DRAFT',createdByUserId:'preserved-user',attachments:{create:{type:'IMAGE',storageKey:'max-photo:policy-answer-'+n}}}});
    await p.$transaction(tx=>recordPreparation(tx,i,'policy-answer-1',new Date('2026-10-12T06:00:00Z')));
    for(let n=0;n<9;n++) await p.incidentAttachment.create({data:{id:'policy-photo-'+n,incidentId:i.id,type:'IMAGE',storageKey:'max-photo:policy-'+n}});
    await p.user.create({data:{id:'policy-employee',maxUserId:99003n,displayName:'Synthetic employee'}});
    await p.operatorSession.create({data:{id:'policy-draft',maxUserId:99003n,chatId:-99009n,incidentId:i.id,type:'WAITING_FOR_ANSWER',expiresAt:new Date('2099-01-01'),data:{confirmation:{token:'synthetic-confirm',action:'input',body:{text:'Synthetic unfinished answer'}},prefillText:'Synthetic unfinished answer'}}});
    await p.privateWorkItem.create({data:{id:'policy-private',maxUserId:99003n,originChatId:-99009n,incidentId:i.id,selected:true,data:{draft:{text:'Synthetic private draft',attachments:[{storageKey:'max-photo:policy-draft'}],nonce:'synthetic',sourceMessageId:'synthetic'}}}});
    for(const kind of ['executor-context','distribution-screen']) await p.systemSetting.create({data:{key:'synthetic-screen:'+kind,value:JSON.stringify({token:'synthetic',mid:'synthetic-mid',incidentId:i.id,groupId:group.id,cycle:cycles[1].id,actions:[{view:'home'}]})}});
    await p.outboundMessage.create({data:{id:'policy-reminder',dedupeKey:'sla-working-v1:'+i.id+':-88000',incidentId:i.id,targetType:'chat',targetId:-88000n,payload:{text:'',operation:{type:'working-deadline',incidentId:i.id}},attachments:[],nextAttemptAt:new Date(0)}});
    await p.outboundMessage.create({data:{id:'policy-cancelled',dedupeKey:'synthetic-cancelled',incidentId:i.id,targetType:'chat',targetId:-88000n,payload:{text:'Synthetic must never send',operation:{type:'working-deadline',incidentId:i.id}},attachments:[],status:'CANCELLED',cancelledAt:new Date('2026-10-15T05:00:00Z'),cancelReason:'ANSWER_DELIVERED',nextAttemptAt:new Date(0)}});
    await p.outboundMessage.create({data:{id:'policy-future-deferred',dedupeKey:'synthetic-future-deferred',incidentId:i.id,targetType:'chat',targetId:-88000n,payload:{text:'',operation:{type:'working-deadline',incidentId:i.id}},attachments:[],status:'DEFERRED',nextAttemptAt:new Date('2099-01-01'),attempts:1,lastError:'Synthetic temporary MAX error'}});
    return snapshot();
  }
  throw Error('Unknown policy operation');
};
