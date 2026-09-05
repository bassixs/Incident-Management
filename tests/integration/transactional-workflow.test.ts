import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import * as outbox from '../../src/delivery/workflow-outbox';
import { MaxMessageService } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createHarness, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_USERS, TEST_CHATS } from '../helpers/setup-env';

describeIntegration('transactional workflow and recovery', () => {
  let prisma: PrismaClient;
  let h: TestHarness;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => prisma.$disconnect());

  const create = () => h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Иван', phone: '+79001234567' }, text: 'Не горит фонарь' });
  const actor = () => actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
  async function assigned(regional = false) {
    const incident = await create();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: regional ? GROUP_CODES.regional : GROUP_CODES.facility } });
    await h.services.distribution.assign(incident.id, group.id, await actor());
    return incident;
  }
  async function awaitingReview() {
    const incident = await assigned();
    const { answer } = await h.services.answers.submit(incident.id, await actor(), 'Фонарь заменён');
    return { incident, answer };
  }

  it('commits registration, history, consumed draft and both outgoing messages together', async () => {
    const session = await h.services.sessions.start({ maxUserId: TEST_USERS.requesterA, chatId: TEST_USERS.requesterA, type: 'WAITING_INCIDENT_CONFIRMATION' });
    const input = { requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Иван', phone: '+79001234567' }, text: 'Фонарь', draftSessionId: session.id };
    const incident = await h.services.incidents.create(input);
    expect(await prisma.operatorSession.count()).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { incidentId: incident.id } })).toBe(2);
    await expect(h.services.incidents.create(input)).rejects.toThrow('уже подтверждён');
    expect(await prisma.incident.count()).toBe(1);
  });

  it('rolls back registration and quota when the outbox write fails', async () => {
    const original = outbox.queueDistribution;
    vi.spyOn(outbox, 'queueDistribution').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('outbox fault'); });
    await expect(create()).rejects.toThrow('outbox fault');
    expect(await prisma.incident.count()).toBe(0);
    expect(await prisma.incidentHistory.count()).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(0);
    expect(await prisma.incidentCounter.count()).toBe(0);
  });

  it('rolls back assignment and its history if queueing fails', async () => {
    const incident = await create();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    vi.spyOn(outbox, 'queueSector').mockRejectedValueOnce(new Error('queue failed'));
    await expect(h.services.distribution.assign(incident.id, group.id, await actor())).rejects.toThrow('queue failed');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('DISTRIBUTION');
    expect(await prisma.incidentHistory.count({ where: { action: 'ASSIGNED' } })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sector-card:${incident.id}` } })).toBe(0);
  });

  it('rolls back rejection when notifying the requester cannot be queued', async () => {
    const incident = await create();
    vi.spyOn(outbox, 'queueRejection').mockRejectedValueOnce(new Error('queue failed'));
    await expect(h.services.distribution.reject(incident.id, 'Причина', await actor())).rejects.toThrow('queue failed');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('DISTRIBUTION');
    expect(await prisma.incidentHistory.count({ where: { action: 'INCIDENT_REJECTED' } })).toBe(0);
  });

  it('a new worker delivers committed assignment after the immediate send is interrupted', async () => {
    const incident = await create();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    vi.spyOn(h.services.sector, 'publishCard').mockRejectedValueOnce(new Error('process interrupted'));
    await expect(h.services.distribution.assign(incident.id, group.id, await actor())).rejects.toThrow('process interrupted');
    const sent: bigint[] = [];
    const max = { sendToChat: async (id: bigint) => { sent.push(id); return { body: { mid: `m-${sent.length}` } }; }, sendToUser: async () => ({ body: { mid: 'user' } }) };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush();
    await worker.flush();
    expect(sent.filter(id => id === TEST_CHATS.sector)).toHaveLength(1);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBeTruthy();
  });

  for (const revision of [false, true]) it(`rolls back both answer and incident on ${revision ? 'revision' : 'approval'} queue failure`, async () => {
    const { incident, answer } = await awaitingReview();
    if (revision) vi.spyOn(outbox, 'queueRevision').mockRejectedValueOnce(new Error('queue failed'));
    else vi.spyOn(outbox, 'queueAnswer').mockRejectedValueOnce(new Error('queue failed'));
    const operation = revision ? h.services.review.requestRevision(incident.id, 'Уточните', await actor()) : h.services.review.approve(incident.id, await actor());
    await expect(operation).rejects.toThrow('queue failed');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('WAITING_REVIEW');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).status).toBe('WAITING_REVIEW');
  });

  for (const direct of [false, true]) it(`rolls back a ${direct ? 'direct' : 'reviewed'} answer when its queue fails`, async () => {
    const incident = await assigned(direct);
    vi.spyOn(outbox, 'queueAnswer').mockRejectedValueOnce(new Error('queue failed'));
    await expect(h.services.answers.submit(incident.id, await actor(), 'Готово')).rejects.toThrow('queue failed');
    expect(await prisma.incidentAnswer.count()).toBe(0);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('ASSIGNED');
  });

  it('does not consume the SLA notification mark when queueing fails', async () => {
    const incident = await create();
    const now = new Date(incident.deadlineAt.getTime() - 3_600_000);
    vi.spyOn(outbox, 'queueMessage').mockRejectedValueOnce(new Error('queue failed'));
    await h.services.sla.sweep(now);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).slaWarn6SentAt).toBeNull();
    await h.services.sla.sweep(now);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sla:${incident.id}:6` } })).toBe(1);
  });

  it('does not delete borrowed answer attachments after delivery', async () => {
    const incident = await assigned(true);
    vi.spyOn(h.services.media, 'ingestAll').mockResolvedValueOnce([{ type: 'IMAGE', storageKey: 'answers/original.jpg', size: 3 }]);
    const { answer } = await h.services.answers.submit(incident.id, await actor(), 'Готово', [{ kind: 'IMAGE', url: 'https://example.test/photo' }]);
    const queued = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } });
    expect(queued.attachments).toEqual([{ type: 'IMAGE', storageKey: 'answers/original.jpg', originalName: null, owned: false }]);
    const remove = vi.fn();
    const max = { uploadImage: async () => ({ type: 'image', payload: { token: 't' } }), sendToChat: async () => ({ body: { mid: 'c' } }), sendToUser: async () => ({ body: { mid: 'u' } }) };
    const worker = new MaxMessageService(max as never, { prisma, storage: { load: async () => Buffer.from('abc'), remove } as never });
    await worker.flush();
    expect(remove).not.toHaveBeenCalledWith('answers/original.jpg');
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } })).status).toBe('SENT');
  });

  for (const regional of [false, true]) it(`shows delivery only after MAX accepts the ${regional ? 'regional' : 'approved'} answer and survives a worker restart`, async () => {
    let fail = true;
    let sequence = 0;
    const edits: string[] = [];
    const chatMessages: string[] = [];
    const max = {
      sendToUser: async (_id: bigint, text: string) => {
        if (fail && text.includes('Получен ответ')) throw new Error('MAX unavailable');
        return { body: { mid: `u-${++sequence}` } };
      },
      sendToChat: async (_id: bigint, text: string) => { chatMessages.push(text); return { body: { mid: `c-${++sequence}` } }; },
      editMessage: async (_id: string, text: string) => { edits.push(text); },
    };
    const storage = {} as never;
    const messages = new MaxMessageService(max as never, { prisma, storage });
    const services = buildServices(prisma, { messages, storage, media: new FakeMediaService() as never });
    const incident = await services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Иван', phone: '+79001234567' }, text: 'Фонарь' });
    await services.distribution.publishCard(incident.id);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: regional ? GROUP_CODES.regional : GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, await actor());
    const submission = await services.answers.submit(incident.id, await actor(), 'Готово');
    if (regional) expect(submission.deliveryQueued).toBe(true);
    else await services.review.approve(incident.id, await actor());
    const answerId = submission.answer.id;
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answerId } })).deliveredAt).toBeNull();
    expect(edits.some(t => t.includes('🟢 ОТРАБОТАНО'))).toBe(false);
    expect(chatMessages.some(t => t.includes('доставлен пользователю'))).toBe(false);
    expect(await services.review.resend(incident.id)).toBe('queued');
    fail = false;
    await prisma.outboundMessage.update({ where: { dedupeKey: `answer:${answerId}` }, data: { nextAttemptAt: new Date(0) } });
    const restartedWorker = new MaxMessageService(max as never, { prisma, storage });
    await restartedWorker.flush();
    await restartedWorker.flush();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answerId } })).deliveredAt).not.toBeNull();
    expect(edits.some(t => t.includes('🟢 ОТРАБОТАНО'))).toBe(true);
    expect(chatMessages.filter(t => t.includes('доставлен пользователю'))).toHaveLength(1);
    expect(await services.review.resend(incident.id)).toBe('already-sent');
  });
});
