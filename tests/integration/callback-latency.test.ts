import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { MaxMessageService } from '../../src/max/max-message.service';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describeIntegration('interactive transitions independent of the global outbox barrier', () => {
  let db: PrismaClient, services: AppServices, worker: MaxMessageService;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  let sent: string[], max: any;
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect());
  afterEach(async () => { worker.stop(); await worker.waitForIdle(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db); sent = [];
    const send = async (_id: bigint, text: string) => { sent.push(text); return { body: { mid: randomUUID() } }; };
    max = { sendToUser: vi.fn(send), sendToChat: vi.fn(send), editMessage: vi.fn(), editCardWithKeyboard: vi.fn() };
    worker = new MaxMessageService(max, { prisma: db, storage: { remove: async () => undefined } as never });
    services = buildServices(db, { messages: worker });
    vi.spyOn(services.max, 'answerCallback').mockResolvedValue({ success: true } as never);
    actor = await actorFor(db, TEST_USERS.admin, 'Тестовый сотрудник', [UserRole.ADMIN]);
  });

  async function incident(review: boolean) {
    const i = await services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Не работает освещение' });
    if (review) {
      const group = await services.responsibleGroups.findByCode(GROUP_CODES.facility);
      await services.distribution.assign(i.id, group!.id, actor);
      await services.answers.submit(i.id, actor, 'Работы выполнены.');
    }
    await worker.flush();
    return (await services.repository.findById(i.id))!;
  }

  it.each([false, true])('next screen does not await unrelated MAX work; review=%s', async review => {
    const i = await incident(review);
    const blocked = gate(), entered = gate();
    max.sendToUser.mockImplementation(async (_id: bigint, text: string) => {
      if (text === 'slow-background') { entered.resolve(); await blocked.promise; }
      sent.push(text); return { body: { mid: randomUUID() } };
    });
    await db.outboundMessage.create({ data: { targetType: 'user', targetId: 88888n, payload: { text: 'slow-background' }, attachments: [] } });
    const draining = worker.flush(); await entered.promise;
    const update = { update_type: 'message_callback', timestamp: Date.now(), callback: {
      callback_id: randomUUID(), user: { user_id: Number(actor.maxUserId), name: actor.displayName },
      payload: `incident:${review ? 'approve' : 'assign'}:${i.id}${review ? ':' + i.answers.at(-1)!.id : ''}`,
    }, message: { recipient: { chat_type: 'chat', chat_id: Number(review ? TEST_CHATS.review : TEST_CHATS.distribution) }, body: { mid: 'source' } } };
    const dispatcher = new UpdateDispatcher(db, { dispatch: (u: unknown) => handleCallbackUpdate(services, { update: u } as never) } as never);
    const before = sent.length;
    const start = performance.now();
    let released = false, screenBeforeRelease = false, elapsed = 0, ackElapsed = 0;
    vi.mocked(services.max.answerCallback).mockImplementation(async () => {
      if (!ackElapsed) ackElapsed = performance.now() - start;
      return { success: true } as never;
    });
    max.sendToChat.mockImplementation(async (_id: bigint, text: string) => {
      sent.push(text);
      if (!elapsed) { elapsed = performance.now() - start; screenBeforeRelease = !released; }
      return { body: { mid: randomUUID() } };
    });
    // Same fixed simulated MAX delay on baseline and candidate. No real API.
    const timer = setTimeout(() => { released = true; blocked.resolve(); }, 5000);
    const click = dispatcher.handle(update as never);
    let verified = false;
    try {
      await click;
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: process.env.LATENCY_BASELINE === '1' ? 6000 : 1000 });
      expect(screenBeforeRelease).toBe(process.env.LATENCY_BASELINE !== '1');
      expect(await dispatcher.handle(update as never)).toBe('duplicate');
      expect(await dispatcher.handle({ ...update, callback: { ...update.callback, callback_id: randomUUID() } } as never)).toBe('processed');
      expect(await db.incidentHistory.count({ where: { incidentId: i.id, action: review ? 'REVIEW_CLAIMED' : 'DISTRIBUTION_CLAIMED' } })).toBe(1);
      expect((await db.incident.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(review ? 'WAITING_REVIEW' : 'DISTRIBUTION');
      console.log(JSON.stringify({ benchmark: review ? 'review-next-screen' : 'distribution-next-screen', baseline: process.env.LATENCY_BASELINE === '1', simulatedMaxMs: 5000, elapsedMs: Math.round(elapsed), ackElapsedMs: Math.round(ackElapsed), screenBeforeRelease }));
      verified = true;
    } finally {
      // On success keep exactly the same 5 s background operation in both runs.
      // On assertion failure release it immediately so teardown cannot hang.
      if (!verified) { clearTimeout(timer); blocked.resolve(); }
      await click; await draining; clearTimeout(timer); await worker.flush();
    }
    expect(await db.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(2);
    const inbox = await db.inboundUpdate.findFirstOrThrow({ orderBy: { sequence: 'asc' } });
    if (process.env.LATENCY_BASELINE !== '1') {
      expect(await db.outboundMessage.count({ where: { payload: { path: ['trace', 'inboxId'], equals: inbox.id } } })).toBeGreaterThan(0);
    }
    expect(await db.outboundMessage.count({ where: { status: { in: ['PENDING', 'SENDING', 'FAILED'] } } })).toBe(0);
  });
});
