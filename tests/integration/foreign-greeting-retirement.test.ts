import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { botAddedGreeting } from '../../src/bot/views/bot-added';
import { previewGreetingRetirement, RETIRED_GREETING_REASON } from '../../src/maintenance/foreign-greeting-retirement';
import { MaxMessageService } from '../../src/max/max-message.service';
import { createHarness, createTestPrisma, describeIntegration, INTEGRATION_DB_URL, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

describeIntegration('explicit retirement of foreign bot_added greetings', () => {
  let prisma: PrismaClient; let h: TestHarness; const workers: MaxMessageService[]=[];
  beforeAll(() => { pushSchemaOnce(); prisma=createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => { await resetDatabase(prisma);await seedCategories(prisma);h=await createHarness(prisma); });
  afterEach(async () => { for(const w of workers)w.stop();await Promise.all(workers.map(w=>w.waitForIdle()));workers.length=0; });
  async function greeting(target=-8888n) {
    const inbox=await prisma.inboundUpdate.create({data:{externalUpdateKey:randomUUID(),updateType:'bot_added',payload:{},status:'PROCESSED'}});
    return prisma.outboundMessage.create({data:{targetType:'chat',targetId:target,payload:{text:botAddedGreeting(target),trace:{inboxId:inbox.id}},attachments:[],status:'PENDING',attempts:5,nextAttemptAt:new Date(Date.now()+3600_000),lastError:'403: Insufficient access rights to perform this action'}});
  }
  function execute(sql:string) {
    // This is a test-only database chosen by the existing integration harness.
    // psql executes the exact generated transaction, including DO/rollback guards.
    const url=new URL(INTEGRATION_DB_URL!);
    if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.endsWith('_test'))throw new Error('Refusing SQL outside local isolated test DB');
    return spawnSync(process.env.TEST_PSQL_BIN??'psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',INTEGRATION_DB_URL!],{input:sql,encoding:'utf8',timeout:20000});
  }
  const worker=()=>{
    const max={sendToChat:vi.fn(async()=>({body:{mid:randomUUID()}})),sendToUser:vi.fn(async()=>({body:{mid:randomUUID()}}))};
    const messages=new MaxMessageService(max as never,{prisma,storage:{} as never});workers.push(messages);return {max,messages};
  };

  it('previews without writes; retires exactly six, preserves records and releases only their recipient ordering',async()=>{
    const rows=[];for(let i=0;i<6;i++)rows.push(await greeting(-8888n-BigInt(i)));
    const ids=rows.map(x=>x.id);const preview=await previewGreetingRetirement(h.services,ids);
    expect(preview.jobs.map(x=>x.id)).toEqual(ids);expect(preview.jobs.map(x=>x.targetId)).toEqual(rows.map(x=>String(x.targetId)));
    expect(await prisma.outboundMessage.findMany({orderBy:{sequence:'asc'}})).toEqual(rows);
    const later=await prisma.outboundMessage.create({data:{targetType:'chat',targetId:rows[0]!.targetId,payload:{text:'following notification'},attachments:[]}});
    const unrelated=await prisma.outboundMessage.create({data:{targetType:'user',targetId:123n,payload:{text:'other 403'},attachments:[],status:'PENDING',attempts:5,nextAttemptAt:new Date(Date.now()+3600_000),lastError:rows[0]!.lastError}});
    const first=worker();await first.messages.flush();expect(first.max.sendToChat).not.toHaveBeenCalled();expect(first.max.sendToUser).not.toHaveBeenCalled();
    const applied=execute(preview.sql);expect(applied.stderr).toBe('');expect(applied.status).toBe(0);
    for(const old of rows){const saved=await prisma.outboundMessage.findUniqueOrThrow({where:{id:old.id}});
      expect(saved).toEqual({...old,status:'FAILED',lastError:RETIRED_GREETING_REASON,updatedAt:expect.any(Date)});
      expect(saved.sentAt).toBeNull();expect(saved.firstMessageId).toBeNull();expect(saved.trackingApplied).toBe(old.trackingApplied);
    }
    expect(await prisma.outboundMessage.findUnique({where:{id:unrelated.id}})).toEqual(unrelated);
    first.messages.stop();await first.messages.waitForIdle();
    const restarted=worker();await restarted.messages.flush();
    expect(restarted.max.sendToChat).toHaveBeenCalledTimes(1);expect(restarted.max.sendToChat.mock.calls[0]).toEqual(expect.arrayContaining(['following notification']));
    expect((await prisma.outboundMessage.findUniqueOrThrow({where:{id:later.id}})).status).toBe('SENT');
    await restarted.messages.flush();expect(restarted.max.sendToChat).toHaveBeenCalledTimes(1);
    expect(await prisma.outboundMessage.count({where:{id:{in:ids},status:'FAILED',sentAt:null}})).toBe(6);
    expect(execute(preview.sql).status).not.toBe(0); // Replaying a stale plan cannot change the already retired rows.
  });

  it.each(['SENDING','delivered','working','other-message','other-403','other-origin','attachments','keyboard','resident-answer'])('refuses %s without changing anything',async variant=>{
    let row=await greeting();
    if(variant==='SENDING')row=await prisma.outboundMessage.update({where:{id:row.id},data:{status:'SENDING',lockedAt:new Date()}});
    if(variant==='delivered')row=await prisma.outboundMessage.update({where:{id:row.id},data:{firstMessageId:'mid.partial'}});
    if(variant==='working')row=await prisma.outboundMessage.update({where:{id:row.id},data:{targetId:TEST_CHATS.review,payload:{...(row.payload as object),text:botAddedGreeting(TEST_CHATS.review)}}});
    if(variant==='other-message')row=await prisma.outboundMessage.update({where:{id:row.id},data:{payload:{...(row.payload as object),text:'ordinary notification'}}});
    if(variant==='other-403')row=await prisma.outboundMessage.update({where:{id:row.id},data:{lastError:'403: other reason'}});
    if(variant==='other-origin')await prisma.inboundUpdate.update({where:{id:(row.payload as any).trace.inboxId},data:{updateType:'message_created'}});
    if(variant==='attachments')row=await prisma.outboundMessage.update({where:{id:row.id},data:{attachments:[{type:'IMAGE',storageKey:'keep'}]}});
    if(variant==='keyboard')row=await prisma.outboundMessage.update({where:{id:row.id},data:{payload:{...(row.payload as object),keyboard:[]}}});
    if(variant==='resident-answer')row=await prisma.outboundMessage.update({where:{id:row.id},data:{trackingType:'ANSWER_TO_REQUESTER'}});
    await expect(previewGreetingRetirement(h.services,[row.id])).rejects.toThrow();
    expect(await prisma.outboundMessage.findUnique({where:{id:row.id}})).toEqual(row);
  });

  it.each(['attempt','claim','binding'])('rolls back the whole plan if %s changes after preview',async variant=>{
    const a=await greeting(),b=await greeting(-8889n);const preview=await previewGreetingRetirement(h.services,[a.id,b.id]);
    if(variant==='attempt')await prisma.outboundMessage.update({where:{id:b.id},data:{attempts:6}});
    if(variant==='claim')await prisma.outboundMessage.update({where:{id:b.id},data:{status:'SENDING',lockedAt:new Date()}});
    if(variant==='binding')await prisma.responsibleGroup.update({where:{code:'FACILITY'},data:{maxChatId:b.targetId}});
    const before=await prisma.outboundMessage.findMany({orderBy:{sequence:'asc'}});
    const result=execute(preview.sql);expect(result.status).not.toBe(0);expect(result.stderr).toContain('Greeting scope changed');
    expect(await prisma.outboundMessage.findMany({orderBy:{sequence:'asc'}})).toEqual(before);
  });

  it('rejects abbreviated, duplicate and missing IDs instead of widening the selection',async()=>{
    const row=await greeting();
    for(const ids of [[row.id.slice(0,8)],[row.id,row.id],[randomUUID()],[]])await expect(previewGreetingRetirement(h.services,ids)).rejects.toThrow();
    expect(await prisma.outboundMessage.findUnique({where:{id:row.id}})).toEqual(row);
  });
});
