'use strict';
const {PrismaClient}=require('/app/node_modules/@prisma/client'),fs=require('fs'),crypto=require('crypto');const p=new PrismaClient();
(async()=>{
 const u=await p.user.create({data:{id:'resident',maxUserId:100001n,displayName:'Synthetic'}});
 const g=await p.responsibleGroup.create({data:{id:'group',code:'REGION_KALUGA',name:'Synthetic',kind:'REGIONAL',maxChatId:-100002n,isActive:false}});
 for(const [id,policy] of [['old','LEGACY'],['new','WORKING_HOURS_V1']]){
 await p.incident.create({data:{id,publicCode:'INC-SYNTH-'+id,requesterId:u.id,requesterMaxUserId:100001n,requesterName:'Synthetic',requesterPhone:'+79000000000',text:'Original synthetic '.repeat(1000),status:'ASSIGNED',assignedGroupId:g.id,deadlineAt:new Date('2099-01-01'),slaPolicy:policy,answers:{create:{id:'answer-'+id,version:1,text:'Long synthetic response '.repeat(600),createdByUserId:u.id,status:'DRAFT',revisionReason:'Synthetic revision'}},history:{create:{id:'history-'+id,action:'ASSIGNED',fromStatus:'DISTRIBUTION',toStatus:'ASSIGNED'}}}});
 for(let i=0;i<9;i++)await p.incidentAttachment.create({data:{id:id+'-photo-'+i,incidentId:id,type:'IMAGE',storageKey:'max-photo:synthetic-'+i,maxToken:'synthetic-photo-'+i}});
 }
 await p.incidentAssignmentCycle.create({data:{id:'cycle',incidentId:'new',sequence:1,groupId:g.id,groupCode:g.code,groupName:g.name,assignedAt:new Date('2026-10-08T10:00:00Z'),preparationDueAt:new Date('2026-10-13T05:00:00Z'),returnDueAt:new Date('2026-10-08T12:00:00Z')}});
 fs.writeFileSync('/app/data/uploads/shared.bin','synthetic attachment');await p.answerAttachment.create({data:{id:'file',answerId:'answer-new',type:'FILE',storageKey:'shared.bin'}});
 await p.operatorSession.create({data:{id:'draft',maxUserId:100001n,chatId:100001n,type:'WAITING_INCIDENT_CONFIRMATION',expiresAt:new Date('2099-01-01'),data:{draftText:'Synthetic unfinished text',requesterPhone:'+79000000000',draftToken:'draft',screenToken:'screen',previewToken:'preview',draftMedia:[{storageKey:'shared.bin',kind:'FILE'}]}}});
 for(const status of ['FAILED','CANCELLED','DEFERRED'])await p.outboundMessage.create({data:{id:status,targetType:'user',targetId:100003n,status,nextAttemptAt:new Date('2099-01-01'),payload:{text:'Synthetic '+status,...(status==='FAILED'?{deliveryProgress:{version:1,planHash:'test-terminal',totalParts:2,mids:['terminal-ack']}}:{})},attachments:[],lastError:status==='FAILED'?'MANUALLY_RETIRED_FOREIGN_BOT_ADDED':null,cancelledAt:status==='CANCELLED'?new Date():null,cancelReason:status==='CANCELLED'?'ANSWER_DELIVERED':null}});
 await p.outboundMessage.create({data:{id:'partial',targetType:'user',targetId:10001n,payload:{text:'SyntheticLong'.repeat(450)},attachments:[]}});
 await p.inboundUpdate.create({data:{id:'in-future',externalUpdateKey:'in-future',updateType:'synthetic_noop',partitionKey:'user:10005',payload:{update_type:'synthetic_noop'},nextAttemptAt:new Date('2099-01-01')}});
 const k='retired.bin',h=crypto.createHash('sha256').update(k).digest('hex');
 await p.systemSetting.createMany({data:[{key:'retention.file-fence.v1:'+h,value:'PERMANENT_STORAGE_KEY_RETIREMENT_V1'},{key:'retention.file-delete.v1:'+h,value:JSON.stringify({version:1,storageKey:k})},{key:'retention.file-state.v1:'+h,value:JSON.stringify({version:1,status:'unknown',attempts:1,nextAttemptAt:0,reason:'STORAGE_RESULT_UNKNOWN'})},{key:'work-panel:sector:-9999',value:'synthetic-existing-mid'}]});
 console.log('SEEDED_SYNTHETIC_ONLY');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>p.$disconnect());
