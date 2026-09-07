import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MaxMessageService } from '../../src/max/max-message.service';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describeIntegration('parallel outbox with recipient ordering', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(() => resetDatabase(prisma));
  afterAll(() => prisma.$disconnect());
  const enqueue = (text: string, targetId = 1n, targetType = 'user') => prisma.outboundMessage.create({ data: {
    targetType, targetId, payload: { text }, attachments: [], trackingApplied: true,
    // Every row has the same timestamp: sequence, not UUID, decides the order.
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } });

  it('a slow chat does not block other recipients; all parts finish before the next message in that chat', async () => {
    const blocked = gate(); const entered = gate(); const sent: string[] = [];
    const long = 'А'.repeat(4000);
    await enqueue(long, 1n, 'chat'); await enqueue('chat-next', 1n, 'chat'); await enqueue('other', 2n, 'chat');
    const sendToChat = vi.fn(async (id: bigint, text: string) => {
      if (id === 1n && !sent.length) { entered.resolve(); await blocked.promise; }
      sent.push(text); return { body: { mid: `mid-${sent.length}` } };
    });
    const worker = new MaxMessageService({ sendToChat } as never, { prisma, storage: {} as never }, 2);
    const work = worker.flush();
    try {
      await entered.promise;
      await vi.waitFor(() => expect(sent).toEqual(['other']));
      expect(sendToChat).toHaveBeenCalledTimes(2);
    } finally { blocked.resolve(); await work; }
    expect(sent.at(-1)).toBe('chat-next');
    expect(sent.slice(1,-1).join('')).toBe(long);
    expect(await prisma.outboundMessage.count({ where: { status: 'SENT' } })).toBe(3);
  });

  it('100 queued messages use at most 8 lanes, remain ordered per recipient and are not duplicated by concurrent flushes', async () => {
    for (let i=0;i<100;i++) await enqueue(String(i), BigInt(i%20));
    const active = new Set<string>(); let peak=0; const sent = new Map<string, number[]>();
    const sendToUser = async (id: bigint, text: string) => {
      const key=String(id); expect(active.has(key)).toBe(false); active.add(key); peak=Math.max(peak,active.size);
      await new Promise(resolve=>setTimeout(resolve,25));
      sent.set(key,[...(sent.get(key)??[]),Number(text)]); active.delete(key);
      return {body:{mid:`mid-${text}`}};
    };
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never},8);
    await Promise.all([worker.flush(),worker.flush()]); await worker.flush();
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
    for(let i=0;i<20;i++) expect(sent.get(String(i))).toEqual([i,i+20,i+40,i+60,i+80]);
    expect(await prisma.outboundMessage.count({where:{status:'SENT'}})).toBe(100);
  });

  it('a single flush drains fast recipients even when lanes finish during a database read', async () => {
    for(let i=0;i<40;i++) await enqueue(String(i),BigInt(i%4));
    const sendToUser=vi.fn().mockResolvedValue({body:{mid:'fast'}});
    await new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never}).flush();
    expect(sendToUser).toHaveBeenCalledTimes(40);
    expect(await prisma.outboundMessage.count({where:{status:'PENDING'}})).toBe(0);
  });

  it('immediate sends cannot overtake an active background message to the same recipient', async () => {
    await enqueue('first'); const blocked=gate(); const entered=gate(); const sent:string[]=[];
    const sendToUser=async (_id: bigint,text:string)=>{
      if(text==='first'){entered.resolve();await blocked.promise;}
      sent.push(text);return {body:{mid:text}};
    };
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never});
    const work=worker.flush();
    try {
      await entered.promise;
      expect((await worker.send({userId:1n},{text:'second'})).state).toBe('queued');
      expect((await worker.send({userId:2n},{text:'other'})).state).toBe('sent');
      expect(sent).toEqual(['other']);
    } finally {blocked.resolve();await work;}
    await worker.flush(); expect(sent).toEqual(['other','first','second']);
  });

  it('one slow lane does not stop the next batch of more than 50 other messages', async () => {
    await enqueue('slow',1n);
    for(let i=0;i<60;i++) await enqueue(`fast-${i}`,2n);
    const blocked=gate();const entered=gate();const sent:string[]=[];
    const max={sendToUser:async (id:bigint,text:string)=>{
      if(id===1n){entered.resolve();await blocked.promise;}
      sent.push(text);return {body:{mid:text}};
    }};
    const worker=new MaxMessageService(max as never,{prisma,storage:{} as never},2);
    const work=worker.flush();
    try {
      await entered.promise;
      await vi.waitFor(()=>expect(sent).toHaveLength(60),{timeout:10000});
      expect(sent).toEqual(Array.from({length:60},(_,i)=>`fast-${i}`));
    } finally {blocked.resolve();await work;}
    expect(sent.at(-1)).toBe('slow');
  });

  it('immediate sends cannot bypass an earlier queued message before a drain starts', async () => {
    await enqueue('first'); const sent:string[]=[];
    const worker=new MaxMessageService({sendToUser:async (_id:bigint,text:string)=>{sent.push(text);return {body:{mid:text}};}} as never,{prisma,storage:{} as never});
    expect((await worker.send({userId:1n},{text:'second'})).state).toBe('queued');
    expect(sent).toEqual([]); await worker.flush(); expect(sent).toEqual(['first','second']);
  });

  it('retry backoff holds only its recipient; a restarted worker preserves that order', async () => {
    const first=await enqueue('first'); await enqueue('second'); await enqueue('other',2n);
    let fail=true; const sent:string[]=[];
    const max={sendToUser:async (_id:bigint,text:string)=>{
      if(text==='first'&&fail) throw new Error('Temporary MAX failure');
      sent.push(text); return {body:{mid:text}};
    }};
    await new MaxMessageService(max as never,{prisma,storage:{} as never}).flush();
    expect(sent).toEqual(['other']);
    const resumed=new MaxMessageService(max as never,{prisma,storage:{} as never});
    await resumed.flush(); expect(sent).toEqual(['other']);
    fail=false;await prisma.outboundMessage.update({where:{id:first.id},data:{nextAttemptAt:new Date(0)}});
    await resumed.flush(); expect(sent).toEqual(['other','first','second']);
  });

  it('a terminal failure does not permanently block the chat', async () => {
    const first=await enqueue('first'); await enqueue('second');
    await prisma.outboundMessage.update({where:{id:first.id},data:{attempts:11}});
    const sent:string[]=[];
    const max={sendToUser:async (_id:bigint,text:string)=>{
      if(text==='first') throw new Error('Unrecoverable');
      sent.push(text);return {body:{mid:text}};
    }};
    const worker=new MaxMessageService(max as never,{prisma,storage:{} as never});
    await worker.flush(); await worker.flush(); expect(sent).toEqual(['second']);
    expect((await prisma.outboundMessage.findUniqueOrThrow({where:{id:first.id}})).status).toBe('FAILED');
  });

  it('future business holds do not block a ready message', async () => {
    const hold=await enqueue('held');await enqueue('ready');
    await prisma.outboundMessage.update({where:{id:hold.id},data:{nextAttemptAt:new Date(Date.now()+60000)}});
    const sendToUser=vi.fn().mockResolvedValue({body:{mid:'ready'}});
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never});
    await worker.flush(); expect(sendToUser).toHaveBeenCalledTimes(1);expect(sendToUser.mock.calls[0]?.[1]).toBe('ready');
  });

  it('deferring a due invitation until rating still lets the next user message through in the same drain', async () => {
    const hold=await enqueue('held');await enqueue('ready');
    // A legacy invitation for a removed incident is also held until rating evidence exists.
    await prisma.outboundMessage.update({where:{id:hold.id},data:{dedupeKey:'subscription-invite:missing',incidentId:'missing'}});
    const sendToUser=vi.fn().mockResolvedValue({body:{mid:'ready'}});
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never});
    await worker.flush();
    expect(sendToUser).toHaveBeenCalledTimes(1);expect(sendToUser.mock.calls[0]?.[1]).toBe('ready');
    expect((await prisma.outboundMessage.findUniqueOrThrow({where:{id:hold.id}})).attempts).toBe(0);
  });

  it('an expired database lease cannot duplicate a still active send in this process', async () => {
    const blocked=gate();const entered=gate();const sendToUser=vi.fn(async()=>{entered.resolve();await blocked.promise;return {body:{mid:'once'}};});
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{} as never});
    const sending=worker.send({userId:1n},{text:'slow',delivery:{dedupeKey:'slow-lease'}});
    try {
      await entered.promise;
      await prisma.outboundMessage.update({where:{dedupeKey:'slow-lease'},data:{lockedAt:new Date(0)}});
      await worker.flush();expect(sendToUser).toHaveBeenCalledTimes(1);
    } finally {blocked.resolve();await sending;}
    expect((await prisma.outboundMessage.findUniqueOrThrow({where:{dedupeKey:'slow-lease'}})).attempts).toBe(1);
  });

  it('chat and user identifiers do not share a lane', async () => {
    await enqueue('chat',1n,'chat');await enqueue('user',1n,'user');
    const blocked=gate();const entered=gate();const sendToUser=vi.fn().mockResolvedValue({body:{mid:'user'}});
    const max={sendToUser,sendToChat:async()=>{entered.resolve();await blocked.promise;return {body:{mid:'chat'}};}};
    const worker=new MaxMessageService(max as never,{prisma,storage:{} as never});const work=worker.flush();
    try {await entered.promise;await vi.waitFor(()=>expect(sendToUser).toHaveBeenCalledTimes(1));}
    finally {blocked.resolve();await work;}
  });

  it('stop drains active lanes and leaves subsequent messages for restart', async () => {
    await enqueue('first');await enqueue('second');await enqueue('other',2n);
    const blocked=gate();const entered=gate();const sent:string[]=[];
    const max={sendToUser:async (_id:bigint,text:string)=>{entered.resolve();await blocked.promise;sent.push(text);return {body:{mid:text}};}};
    const worker=new MaxMessageService(max as never,{prisma,storage:{} as never},1);
    const work=worker.flush();await entered.promise;worker.stop();const idle=worker.waitForIdle();
    blocked.resolve();await Promise.all([work,idle]);expect(sent).toEqual(['first']);
    await new MaxMessageService(max as never,{prisma,storage:{} as never}).flush();
    expect(sent).toHaveLength(3);expect(sent.filter(s=>s!=='other')).toEqual(['first','second']);
  });
});
