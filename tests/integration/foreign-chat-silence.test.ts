import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { registerHandlers } from '../../src/bot/bot';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { COMMANDS } from '../../src/bot/commands';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

describeIntegration('foreign chats stay silent through inbox and the registered router', () => {
  let prisma: PrismaClient; let h: TestHarness; let inbox: UpdateDispatcher;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    vi.spyOn(h.services.max, 'answerCallback').mockResolvedValue();
    vi.spyOn(h.services.max, 'getChat').mockImplementation(async () => { throw new Error('No live API allowed'); });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live API allowed'); }));
    registerHandlers(h.services); inbox = new UpdateDispatcher(prisma, h.services.max);
  });
  afterEach(() => vi.unstubAllGlobals());
  const person = (id = 81001) => ({ user_id: id, name: 'Test employee', is_bot: false });
  const message = (type: string, chat: number, text: string, user = 81001, attachments: any[] = []) => ({
    update_type: 'message_created', timestamp: Date.now(), message: { timestamp: Date.now(), sender: person(user),
      recipient: { chat_type: type, chat_id: chat }, body: { mid: randomUUID(), text, attachments } },
  });
  const press = (type: string, chat: number, payload: string, user = 81001) => ({
    update_type: 'message_callback', timestamp: Date.now(), callback: { callback_id: randomUUID(), payload, user: person(user) },
    message: message(type, chat, '', user).message,
  });
  const accept = (event: unknown) => inbox.handle(event as never);
  const business = async () => ({
    users: await prisma.user.findMany({ orderBy: { id: 'asc' } }), groups: await prisma.responsibleGroup.findMany({ orderBy: { id: 'asc' } }),
    sessions: await prisma.operatorSession.findMany(), work: await prisma.privateWorkItem.findMany(), locks: await prisma.actionLock.findMany(),
    incidents: await prisma.incident.findMany(), answers: await prisma.incidentAnswer.findMany(), history: await prisma.incidentHistory.findMany(),
    audit: await prisma.adminAuditLog.findMany(), settings: await prisma.systemSetting.findMany(), outbox: await prisma.outboundMessage.findMany(),
  });
  const silent = () => {
    expect(h.messages.sent).toEqual([]); expect(h.messages.edits).toEqual([]); expect(h.messages.deleted).toEqual([]);
    expect(h.services.max.answerCallback).not.toHaveBeenCalled(); expect(h.services.max.getChat).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  };

  it.each(['chat','channel'])('does not enroll or greet a foreign %s even if MAX would allow publishing', async type => {
    // Presence/admin rights/publicity cannot participate in the decision: no MAX lookup is made.
    vi.mocked(h.services.max.getChat).mockResolvedValue({ type, is_public: true, status: 'active' } as never);
    const before = await business();
    await accept({ update_type: 'bot_added', timestamp: Date.now(), chat_id: -8888, is_channel: type === 'channel', user: person(9001) });
    silent(); expect(await business()).toEqual(before);
  });

  it.each(['chat','channel'])('ignores every command, ordinary input, contacts and copied buttons in foreign %s', async type => {
    await h.services.sessions.start({ maxUserId: 81001n, chatId: -8888n, type: 'WAITING_REPORT_PERIOD' });
    const before = await business();
    for (const cmd of Object.keys(COMMANDS)) await accept(message(type,-8888,`/${cmd} invalid arguments`));
    for (const text of ['ordinary text','/unknown','/chatid','/whoami','/group_chat FACILITY -8888']) await accept(message(type,-8888,text));
    await accept(message(type,-8888,'contact',81001,[{type:'contact',payload:{vcf_info:'fake'}}]));
    for (const payload of ['broken','user:new','personal:home','personal:resident','queue:next','work:next','session:cancel','report:all','help:guide','cleanup:all',`incident:take:${randomUUID()}`]) {
      await accept(press(type,-8888,payload));
    }
    // Global ADMIN is no exception for arbitrary commands or callbacks.
    for (const text of ['/rules','/role 81001 ADMIN','/group_chat FACILITY -8888','/chatid extra']) await accept(message(type,-8888,text,9001));
    await accept(press(type,-8888,'user:new',9001));
    silent(); expect(await business()).toEqual(before);
    expect(await prisma.inboundUpdate.count({where:{status:{not:'PROCESSED'}}})).toBe(0);
  });

  it('blocks already admitted privacy/contact errors before any reply or actor change', async () => {
    const before=await business();
    for (const flag of ['privacyRejected','contactRejected','verifiedDraftContact']) {
      await handleMessageUpdate(h.services,{update:{...message('channel',-8888,''),[flag]:true}} as never);
    }
    silent(); expect(await business()).toEqual(before);
  });

  it('ignores foreign membership/removal, disabled groups and old callbacks after a binding moves', async () => {
    await h.services.sessions.start({maxUserId:81001n,chatId:-8888n,type:'WAITING_REPORT_PERIOD'});
    await prisma.responsibleGroup.update({where:{code:'FACILITY'},data:{isActive:false}});
    const before=await business();
    for (const type of ['user_added','user_removed']) await accept({update_type:type,timestamp:Date.now(),chat_id:-8888,user:person(),is_channel:false});
    await accept(message('chat',Number(TEST_CHATS.sector),'/queue')); await accept(press('chat',Number(TEST_CHATS.sector),'session:cancel'));
    silent(); expect(await business()).toEqual(before);
    await prisma.responsibleGroup.update({where:{code:'FACILITY'},data:{isActive:true,maxChatId:-8890n}});
    const moved=await business();await accept(press('chat',Number(TEST_CHATS.sector),'work:next'));
    silent(); expect(await business()).toEqual(moved);
  });

  it.each([9001,81002])('discovers the ID privately and enrolls from ADMIN dialog (%i, env/stored role)', async admin => {
    if(admin===81002) await prisma.user.create({data:{maxUserId:BigInt(admin),displayName:'Admin',roles:['ADMIN']}});
    const before=await business();
    await accept(message('channel',-8888,'/chatid',81001));silent();expect(await business()).toEqual(before);
    await accept(message('channel',-8888,'/chatid',admin));
    expect(h.messages.sent).toHaveLength(1);expect(h.messages.sent[0]!.target).toEqual({userId:BigInt(admin)});
    expect(h.messages.sent[0]!.message.text).toContain('/group_chat <КОД> -8888');expect(await business()).toEqual(before);
    await accept(message('dialog',81001,'/group_chat FACILITY -8888'));
    expect((await prisma.responsibleGroup.findUniqueOrThrow({where:{code:'FACILITY'}})).maxChatId).toBe(TEST_CHATS.sector);
    await accept(message('dialog',admin,'/group_chat FACILITY -8888',admin));
    expect((await prisma.responsibleGroup.findUniqueOrThrow({where:{code:'FACILITY'}})).maxChatId).toBe(-8888n);
    expect(await prisma.adminAuditLog.count()).toBe(1);
    await accept(message('channel',-8888,'/info'));
    expect(h.messages.toChat(-8888n).at(-1)!.message.text).toContain('Хозяйственная группа');
    const beforeDrafts=await prisma.operatorSession.count();await accept(press('channel',-8888,'user:new'));
    expect(await prisma.operatorSession.count()).toBe(beforeDrafts);
    expect(h.services.max.answerCallback).toHaveBeenLastCalledWith(expect.any(String),'Откройте личный диалог с ботом.');
  });

  it('keeps configured chat greetings/help/callbacks and private resident/staff routing', async () => {
    for (const chat of [TEST_CHATS.distribution,TEST_CHATS.review,TEST_CHATS.sector,-1005n]) {
      await accept({update_type:'bot_added',timestamp:Date.now(),chat_id:Number(chat),user:person(),is_channel:false});
      await accept(message('chat',Number(chat),'/info'));
      expect(h.messages.toChat(chat).length).toBeGreaterThanOrEqual(2);
    }
    await accept(press('chat',Number(TEST_CHATS.review),'work:next'));
    expect(h.services.max.answerCallback).toHaveBeenCalled();
    await accept(message('dialog',81001,'/start'));expect(h.messages.toUser(81001n).at(-1)!.message.text).toContain('Добро пожаловать');
    await accept(press('dialog',81001,'user:new'));expect(await prisma.operatorSession.count({where:{maxUserId:81001n}})).toBe(1);
    await accept(message('dialog',9001,'/work',9001));expect(h.messages.toUser(9001n).length).toBeGreaterThan(0);
    expect(await prisma.inboundUpdate.count({where:{status:{not:'PROCESSED'}}})).toBe(0);
  });
});
