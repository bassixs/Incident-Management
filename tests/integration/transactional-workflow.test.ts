import { MediaService } from '../../src/media/media.service';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import * as outbox from '../../src/delivery/workflow-outbox';
import { MaxMessageService } from '../../src/max/max-message.service';
import type { SendMessageExtra } from '../../src/max/max-types';
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

  it('binds approval and revision to the answer version shown on the card', async () => {
    const { incident, answer: first } = await awaitingReview();
    const reviewer = await actor();
    await h.services.review.requestRevision(incident.id, 'Уточните', reviewer, first.id);
    const { answer: second } = await h.services.answers.submit(incident.id, reviewer, 'Уточнённый ответ');
    await expect(h.services.review.approve(incident.id, reviewer, first.id)).rejects.toThrow('устарела');
    await expect(h.services.review.requestRevision(incident.id, 'Старая причина', reviewer, first.id)).rejects.toThrow('устарела');
    const context = { services: h.services, actor: { ...reviewer, roles: [UserRole.ADMIN] }, chatId: TEST_CHATS.review, messageId: 'old-card' };
    await expect(handleIncidentCallback(context, { kind: 'incident', action: 'approve', incidentId: incident.id, argument: first.id })).rejects.toThrow('устарела');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('WAITING_REVIEW');
    await h.services.review.approve(incident.id, reviewer, second.id);
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('APPROVED');
  });

  it('rolls back a stale approval even when revision and resubmission race with its initial read', async () => {
    const { incident, answer } = await awaitingReview();
    const reviewer = await actor();
    const original = h.services.repository.findById.bind(h.services.repository);
    vi.spyOn(h.services.repository, 'findById').mockImplementationOnce(async id => {
      const stale = await original(id);
      await h.services.review.requestRevision(id, 'Уточните', reviewer, answer.id);
      await h.services.answers.submit(id, reviewer, 'Новая версия');
      return stale;
    });
    await expect(h.services.review.approve(incident.id, reviewer, answer.id)).rejects.toThrow('Версия ответа изменилась');
    expect((await original(incident.id))?.status).toBe('WAITING_REVIEW');
    expect(await prisma.incidentAnswer.count({ where: { status: 'APPROVED' } })).toBe(0);
  });

  it('tracks the newest review card and ignores late delivery of an older version', async () => {
    const { incident, answer: first } = await awaitingReview();
    const reviewer = await actor();
    await h.services.review.requestRevision(incident.id, 'Уточните', reviewer, first.id);
    const { answer: second } = await h.services.answers.submit(incident.id, reviewer, 'Новый ответ');
    let counter = 0;
    const max = { sendToChat: async () => ({ body: { mid: `tracked-${++counter}` } }), sendToUser: async () => ({ body: { mid: `tracked-${++counter}` } }), editMessage: async () => undefined, editCardWithKeyboard: async () => undefined };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush();
    const delivery = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `review-card:${second.id}` } });
    expect((await h.services.repository.findById(incident.id))?.reviewMessageId).toBe(delivery.firstMessageId);
    await prisma.outboundMessage.update({ where: { dedupeKey: `review-card:${first.id}` }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    await worker.flush();
    expect((await h.services.repository.findById(incident.id))?.reviewMessageId).toBe(delivery.firstMessageId);
    // A pre-upgrade button without a version is safe only with matching outbox evidence.
    const context = { services: h.services, actor: { ...reviewer, roles: [UserRole.ADMIN] }, chatId: TEST_CHATS.review, messageId: delivery.firstMessageId! };
    await handleIncidentCallback(context, { kind: 'incident', action: 'revision', incidentId: incident.id });
    const session = await h.services.sessions.find(reviewer.maxUserId, TEST_CHATS.review);
    expect(session?.data).toMatchObject({ reviewAnswerId: second.id });
  });

  it('does not consume a draft or advance an answer when saving its photo fails', async () => {
    const photo = [{ kind: 'IMAGE' as const, url: 'https://example.test/photo' }];
    vi.spyOn(h.services.media, 'ingestAll').mockRejectedValueOnce(new Error('photo unavailable'));
    const session = await h.services.sessions.start({ maxUserId: TEST_USERS.requesterA, chatId: TEST_USERS.requesterA, type: 'WAITING_INCIDENT_CONFIRMATION' });
    await expect(h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Иван', phone: '+79001234567' }, text: 'Фонарь', media: photo, draftSessionId: session.id })).rejects.toThrow('photo unavailable');
    expect(await prisma.incident.count()).toBe(0);
    expect(await prisma.operatorSession.count()).toBe(1);
    const incident = await assigned();
    vi.spyOn(h.services.media, 'ingestAll').mockRejectedValueOnce(new Error('photo unavailable'));
    await expect(h.services.answers.submit(incident.id, await actor(), 'Ответ', photo)).rejects.toThrow('photo unavailable');
    expect((await h.services.repository.findById(incident.id))?.status).toBe('ASSIGNED');
    expect(await prisma.incidentAnswer.count()).toBe(0);
  });

  it('keeps no local photo files when a token-only registration transaction rolls back', async () => {
    const files = new Map<string, Buffer>();
    const storage = { save: async ({ key, body }: { key: string; body: Buffer }) => { files.set(key, body); return { storageKey: key, size: body.length }; }, remove: async (key: string) => { files.delete(key); } };
    const media = new MediaService(storage as never, { downloadFromUrl: async () => ({ body: Buffer.from('photo') }) } as never);
    const services = buildServices(prisma, { media, messages: h.messages as never });
    vi.spyOn(outbox, 'queueDistribution').mockRejectedValueOnce(new Error('queue failed'));
    await expect(services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Иван', phone: '+79001234567' }, text: 'Фонарь', media: [{ kind: 'IMAGE', token: 'max-photo', url: 'https://example.test/photo' }] })).rejects.toThrow('queue failed');
    expect(files.size).toBe(0);
    expect(await prisma.incident.count()).toBe(0);
  });

  it('keeps an answer undelivered until its missing stored file is restored', async () => {
    const { incident, answer } = await awaitingReview();
    await prisma.answerAttachment.create({ data: { answerId: answer.id, type: 'FILE', storageKey: 'answer.pdf', originalName: 'answer.pdf', size: 3 } });
    await h.services.review.approve(incident.id, await actor());
    // The fake immediate transport above is only setup; exercise the real worker below.
    await prisma.incidentAnswer.update({ where: { id: answer.id }, data: { deliveredAt: null } });
    let available = false;
    const uploadFile = vi.fn().mockResolvedValue({ type: 'file', payload: { token: 'test' } });
    const max = { uploadFile, sendToUser: vi.fn().mockResolvedValue({ body: { mid: 'delivered' } }), sendToChat: async () => ({ body: { mid: 'chat' } }), editCardWithKeyboard: async () => undefined, editMessage: async () => undefined };
    const storage = { load: async () => { if (!available) throw new Error('file temporarily unavailable'); return Buffer.from('pdf'); }, remove: async () => undefined };
    const worker = new MaxMessageService(max as never, { prisma, storage: storage as never });
    // Isolate the answer from setup notifications.
    await prisma.outboundMessage.updateMany({ where: { NOT: { dedupeKey: `answer:${answer.id}` } }, data: { status: 'SENT' } });
    await worker.flush();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    expect(max.sendToUser).not.toHaveBeenCalled();
    available = true;
    await prisma.outboundMessage.update({ where: { dedupeKey: `answer:${answer.id}` }, data: { nextAttemptAt: new Date(0) } });
    await worker.flush();
    expect(uploadFile).toHaveBeenCalledWith(Buffer.from('pdf'), 'answer.pdf');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).not.toBeNull();
  });

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
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).slaWarn24SentAt).toBeNull();
    await h.services.sla.sweep(now);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sla:${incident.id}:24` } })).toBe(1);
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
    let failInvite = true;
    let sequence = 0;
    const edits: string[] = [];
    const chatMessages: string[] = [];
    const userMessages: Array<{ userId: bigint; text: string; extra?: SendMessageExtra }> = [];
    const max = {
      sendToUser: async (userId: bigint, text: string, extra?: SendMessageExtra) => {
        if (fail && text.includes('Получен ответ')) throw new Error('MAX unavailable');
        if (failInvite && text.includes('Подпишитесь:')) throw new Error('Invite unavailable');
        userMessages.push({ userId, text, extra });
        return { body: { mid: `u-${++sequence}` } };
      },
      sendToChat: async (_id: bigint, text: string) => { chatMessages.push(text); return { body: { mid: `c-${++sequence}` } }; },
      editCardWithKeyboard: async (_id: string, text: string) => { edits.push(text); }, editMessage: async (_id: string, text: string) => { edits.push(text); },
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
    const inviteKey = `subscription-invite:${incident.id}`;
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: inviteKey } })).toBe(0);
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
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: inviteKey } })).toBe(0);
    await services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 4);
    await restartedWorker.flush();
    const queuedInvite = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: inviteKey } });
    expect(queuedInvite.status).toBe('PENDING');
    expect(queuedInvite.targetId).toBe(TEST_USERS.requesterA);
    expect(userMessages.some(message => message.text.includes('Подпишитесь:'))).toBe(false);
    failInvite = false;
    await prisma.outboundMessage.update({ where: { dedupeKey: inviteKey }, data: { nextAttemptAt: new Date(0) } });
    const inviteWorker = new MaxMessageService(max as never, { prisma, storage });
    await inviteWorker.flush();
    await inviteWorker.flush();
    const invitations = userMessages.filter(message => message.text.includes('Подпишитесь:'));
    expect(invitations).toHaveLength(1);
    expect(invitations[0]!.userId).toBe(TEST_USERS.requesterA);
    expect(invitations[0]!.extra?.attachments).toEqual([{
      type: 'inline_keyboard', payload: { buttons: [
        [{ type: 'link', text: 'Владислав Шапша', url: 'https://max.ru/Shapsha_VV' }],
        [{ type: 'link', text: 'Правительство Калужской области', url: 'https://max.ru/pravitelstvo40' }],
      ] },
    }]);
    expect(userMessages.filter(message => message.text.includes('Получен ответ'))).toHaveLength(1);
    expect(userMessages.findIndex(message => message.text.includes('Подпишитесь:')))
      .toBeGreaterThan(userMessages.findIndex(message => message.text.includes('Получен ответ')));
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: inviteKey } })).status).toBe('SENT');
  });

  it('rolls back the rating when queueing its invitation fails', async () => {
    const incident = await assigned(true);
    await h.services.answers.submit(incident.id, await actor(), 'Готово');
    vi.spyOn(outbox, 'queueSubscriptionInvite').mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5)).rejects.toThrow('queue unavailable');
    expect((await h.services.repository.findById(incident.id))!.responseRating).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_RATED' } })).toBe(0);
    await h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `subscription-invite:${incident.id}` } })).toBe(1);
  });

  it('holds a legacy queued invitation until the requester rates and then releases it', async () => {
    const incident = await assigned(true);
    await h.services.answers.submit(incident.id, await actor(), 'Готово');
    const dedupeKey = `subscription-invite:${incident.id}`;
    await prisma.$transaction(tx => outbox.queueMessage(tx, { userId: TEST_USERS.requesterA }, {
      text: 'Подпишитесь:', delivery: { dedupeKey },
    }, incident.id));
    // Other deliveries have already been simulated by the harness.
    await prisma.outboundMessage.updateMany({ where: { dedupeKey: { not: dedupeKey } }, data: { status: 'SENT' } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'invite' } });
    const worker = new MaxMessageService({ sendToUser } as never, { prisma, storage: {} as never });
    await worker.flush();
    expect(sendToUser).not.toHaveBeenCalled();
    const held = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey } });
    expect(held.status).toBe('PENDING');
    expect(held.attempts).toBe(0);
    await h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 3);
    await worker.flush();
    await worker.flush();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey } })).status).toBe('SENT');
  });

  it('does not offer channel subscriptions after a rejection', async () => {
    const incident = await create();
    await h.services.distribution.reject(incident.id, 'Обращение не относится к компетенции', await actor());
    const texts: string[] = [];
    const max = {
      sendToUser: async (_id: bigint, text: string) => { texts.push(text); return { body: { mid: 'user' } }; },
      sendToChat: async () => ({ body: { mid: 'chat' } }),
    };
    await new MaxMessageService(max as never, { prisma, storage: {} as never }).flush();
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `subscription-invite:${incident.id}` } })).toBe(0);
    expect(texts.some(text => text.includes('Подпишитесь:'))).toBe(false);
  });
});
