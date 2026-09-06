import { type PrismaClient, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { MaxMessageService } from '../../src/max/max-message.service';
import { slaStage } from '../../src/sla/sla-notification';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import * as outbox from '../../src/delivery/workflow-outbox';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('clarifications, requester routing and paused SLA', () => {
  let prisma: PrismaClient;
  let services: AppServices;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  let sends: Array<{ target: bigint; text: string; extra: any }>;
  let failQuestion: boolean;
  let media: { ingestAll: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>; load: (key: string) => Promise<Buffer> };
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    sends = [];
    failQuestion = false;
    const max = {
      sendToUser: async (target: bigint, text: string, extra: any) => {
        if (failQuestion && text.includes('Вопрос специалиста:')) throw new Error('MAX unavailable');
        sends.push({ target, text, extra }); return { body: { mid: `u-${sends.length}` } };
      },
      sendToChat: async (target: bigint, text: string, extra: any) => {
        sends.push({ target, text, extra }); return { body: { mid: `c-${sends.length}` } };
      },
      editMessage: vi.fn(async () => undefined),
      uploadImage: async () => ({ type: 'image', payload: { token: 'photo-token' } }),
    };
    const storage = { load: async () => Buffer.from('photo'), remove: vi.fn(async () => undefined) };
    media = { ingestAll: vi.fn(async (prefix: string, items: any[]) => items.map((_, i) => ({
      type: 'IMAGE', storageKey: `${prefix}/${i}.jpg`, originalName: 'photo.jpg', size: 5,
    }))), discard: vi.fn(async () => undefined), load: storage.load };
    const messages = new MaxMessageService(max as never, { prisma, storage: storage as never });
    services = buildServices(prisma, { messages, storage: storage as never, media: media as never });
    vi.spyOn(services.legal, 'hasCurrentAccess').mockResolvedValue(true);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Сотрудник', [UserRole.ADMIN]);
  });

  async function routed(userId = TEST_USERS.requesterA) {
    const incident = await services.incidents.create({ requester: { maxUserId: userId, name: 'Иванов Иван', phone: '+79001112233' }, text: 'Не работает фонарь' });
    await services.distribution.publishCard(incident.id);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, actor);
    return incident;
  }
  async function ask(incidentId: string, source = 'question') {
    const draft = await services.clarifications.prepare(incidentId, actor, TEST_CHATS.sector, 'Уточните адрес дома', source);
    await services.clarifications.confirm(incidentId, draft.id, actor, TEST_CHATS.sector);
    return draft;
  }
  const advance = (hours: number) => vi.setSystemTime(Date.now() + hours * 3_600_000);

  it('previews without pausing, then cancels without contacting the requester', async () => {
    const incident = await routed();
    const draft = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Какой дом?', 'preview');
    expect((await services.repository.findById(incident.id))!.slaPausedAt).toBeNull();
    expect(sends.some(item => item.text.includes('Вопрос специалиста:'))).toBe(false);
    await services.clarifications.cancel(incident.id, draft.id, actor, TEST_CHATS.sector);
    await expect(services.clarifications.confirm(incident.id, draft.id, actor, TEST_CHATS.sector)).rejects.toThrow('обработан');
  });

  it('pauses only after delivery, preserves 52 hours remaining and resumes reminders', async () => {
    const incident = await routed();
    advance(20);
    failQuestion = true;
    const draft = await ask(incident.id);
    expect((await services.repository.findById(incident.id))!.slaPausedAt).toBeNull();
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PENDING_DELIVERY');
    failQuestion = false;
    await prisma.outboundMessage.update({ where: { dedupeKey: `clarification-question:${draft.id}` }, data: { nextAttemptAt: new Date(0) } });
    await services.messages.flush();
    const paused = (await services.repository.findById(incident.id))!;
    expect(paused.slaPausedAt?.getTime()).toBe(Date.now());
    advance(100);
    expect(slaStage(paused, new Date())).toBeUndefined();
    expect((await services.sla.sweep()).overdue).toBe(0);
    expect(await services.repository.listOverdueForReport(new Date())).toHaveLength(0);
    await services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Дом 10', [], 'reply');
    const resumed = (await services.repository.findById(incident.id))!;
    expect(resumed.slaPausedAt).toBeNull();
    expect(resumed.activeClarificationId).toBeNull();
    expect(resumed.deadlineAt.getTime() - Date.now()).toBe(52 * 3_600_000);
    expect(resumed.slaPausedMs).toBe(BigInt(100 * 3_600_000));
    expect(slaStage(resumed, new Date())).toBeUndefined();
    advance(4);
    expect((await services.sla.sweep()).warned24).toBe(1);
    const second = await ask(incident.id, 'question-2');
    advance(2);
    await services.clarifications.reply(second.id, TEST_USERS.requesterA, 'Рядом с подъездом', [], 'reply-2');
    expect((await services.repository.findById(incident.id))!.slaPausedMs).toBe(BigInt(102 * 3_600_000));
  });

  it('binds the complete button/question/reply/photo flow to the right incident and card', async () => {
    const incident = await routed();
    const other = await routed(TEST_USERS.requesterB);
    const staffContext = { services, actor, chatId: TEST_CHATS.sector };
    await handleIncidentCallback(staffContext, { kind: 'incident', action: 'clarify', incidentId: incident.id });
    const session = (await services.sessions.find(actor.maxUserId, TEST_CHATS.sector))!;
    await handleOperatorMessage(services, actor, TEST_CHATS.sector, { body: { mid: 'staff-question', text: 'Укажите точный адрес', attachments: [] } } as never, session);
    const draft = await prisma.clarification.findUniqueOrThrow({ where: { questionSourceId: 'staff-question' } });
    await handleIncidentCallback(staffContext, { kind: 'incident', action: 'clarify-send', incidentId: incident.id, argument: draft.id });
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Иванов Иван', []);
    await handleUserCallback({ services, actor: requester, chatId: requester.maxUserId, messageId: undefined, callbackId: 'reply-button' },
      { kind: 'user', action: 'clarify-reply', argument: draft.id });
    await handleRequesterMessage(services, requester, requester.maxUserId, { body: { mid: 'resident-reply', text: 'Улица Ленина, дом 10',
      attachments: [{ type: 'image', payload: { url: 'https://example.test/photo' } }] } } as never);
    const delivered = sends.filter(item => item.text.includes('Получено уточнение'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.target).toBe(TEST_CHATS.sector);
    expect(delivered[0]!.text).toContain(incident.publicCode);
    expect(delivered[0]!.text).not.toContain(other.publicCode);
    expect(delivered[0]!.extra.link).toEqual({ type: 'reply', mid: (await services.repository.findById(incident.id))!.sectorMessageId });
    expect(delivered[0]!.extra.attachments[0].type).toBe('image');
    expect(await prisma.clarificationAttachment.count({ where: { clarificationId: draft.id } })).toBe(1);
    expect(await services.sessions.find(requester.maxUserId, requester.maxUserId)).toBeNull();
    expect((await services.repository.findById(other.id))!.deadlineAt).toEqual(other.deadlineAt);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `subscription-invite:${incident.id}` } })).toBe(0);
  });

  it('holds an already queued reminder during the pause without exhausting retries', async () => {
    const incident = await routed();
    advance(25);
    const question = await ask(incident.id);
    await prisma.$transaction(tx => outbox.queueMessage(tx, { chatId: TEST_CHATS.sector }, {
      text: 'Reminder queued before the pause',
      operation: { type: 'sla-reminder', incidentId: incident.id, stage: 24 },
      delivery: { dedupeKey: 'held-reminder' },
    }, incident.id));
    for (let i = 0; i < 13; i += 1) {
      advance(1);
      await services.messages.flush();
    }
    const held = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'held-reminder' } });
    expect(held.status).toBe('PENDING');
    expect(held.attempts).toBe(0);
    expect(sends.some(item => item.text.includes('Напоминание:'))).toBe(false);
    await services.clarifications.reply(question.id, TEST_USERS.requesterA, 'Дом 5', [], 'resume-held');
    advance(1);
    await services.messages.flush();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'held-reminder' } })).status).toBe('SENT');
    expect(sends.filter(item => item.text.includes('Напоминание:'))).toHaveLength(1);
  });

  it('refuses a different chat, staff author or requester, and blocks final answers while waiting', async () => {
    const incident = await routed();
    await expect(services.clarifications.prepare(incident.id, actor, TEST_CHATS.otherSector, 'Адрес?', 'wrong-chat')).rejects.toThrow('профильном');
    const draft = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Адрес?', 'auth');
    const colleague = await actorFor(prisma, TEST_USERS.responder, 'Коллега', [UserRole.RESPONDER]);
    await expect(services.clarifications.confirm(incident.id, draft.id, colleague, TEST_CHATS.sector)).rejects.toThrow('автор');
    await services.clarifications.confirm(incident.id, draft.id, actor, TEST_CHATS.sector);
    await expect(services.clarifications.reply(draft.id, TEST_USERS.requesterB, 'Чужой ответ', [], 'wrong')).rejects.toThrow('недоступно');
    await expect(services.answers.submit(incident.id, actor, 'Готово')).rejects.toThrow('уточнения');
    await expect(services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Видео', [{ kind: 'VIDEO' }], 'video')).rejects.toThrow('не принимаются');
    expect(media.ingestAll).not.toHaveBeenCalledWith(expect.anything(), [{ kind: 'VIDEO' }]);
    const paused = await services.repository.findById(incident.id);
    const uploadsBefore = media.ingestAll.mock.calls.length;
    await expect(services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Уточнение',
      [{ kind: 'IMAGE' }, { kind: 'FILE', filename: 'photo.jpg' }], 'file')).rejects.toThrow('не принимаются');
    expect(media.ingestAll).toHaveBeenCalledTimes(uploadsBefore);
    expect(await services.repository.findById(incident.id)).toMatchObject({
      activeClarificationId: draft.id, slaPausedAt: paused!.slaPausedAt, deadlineAt: paused!.deadlineAt,
    });
  });

  it('allows one concurrent request and one reply without extending SLA twice', async () => {
    const incident = await routed();
    const first = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Первый?', 'concurrent-1');
    const second = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Второй?', 'concurrent-2');
    const results = await Promise.allSettled([services.clarifications.confirm(incident.id, first.id, actor, TEST_CHATS.sector), services.clarifications.confirm(incident.id, second.id, actor, TEST_CHATS.sector)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const id = (await services.repository.findById(incident.id))!.activeClarificationId!;
    advance(3);
    const replies = await Promise.allSettled([services.clarifications.reply(id, TEST_USERS.requesterA, 'Дом 1', [], 'reply-1'), services.clarifications.reply(id, TEST_USERS.requesterA, 'Дом 2', [], 'reply-2')]);
    expect(replies.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((await services.repository.findById(incident.id))!.deadlineAt.getTime()).toBe(incident.deadlineAt.getTime() + 3 * 3_600_000);
    expect(sends.filter(item => item.text.includes('Получено уточнение'))).toHaveLength(1);
  });

  it('rolls back confirmation and reply with their queues and retains the pause on media failure', async () => {
    const incident = await routed();
    const draft = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Адрес?', 'rollback');
    vi.spyOn(outbox, 'queueMessage').mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(services.clarifications.confirm(incident.id, draft.id, actor, TEST_CHATS.sector)).rejects.toThrow('queue unavailable');
    expect((await services.repository.findById(incident.id))!.activeClarificationId).toBeNull();
    await services.clarifications.confirm(incident.id, draft.id, actor, TEST_CHATS.sector);
    media.ingestAll.mockRejectedValueOnce(new Error('download failed'));
    await expect(services.clarifications.reply(draft.id, TEST_USERS.requesterA, '', [{ kind: 'IMAGE' }], 'media-fail')).rejects.toThrow('download failed');
    vi.spyOn(outbox, 'queueMessage').mockRejectedValueOnce(new Error('reply queue unavailable'));
    await expect(services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Дом 5', [], 'failed-reply')).rejects.toThrow('reply queue unavailable');
    expect((await services.repository.findById(incident.id))!.slaPausedAt).not.toBeNull();
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('WAITING_REPLY');
    await services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Дом 5', [], 'retry');
    await services.clarifications.reply(draft.id, TEST_USERS.requesterA, 'Дом 5', [], 'retry');
    expect(sends.filter(item => item.text.includes('Получено уточнение'))).toHaveLength(1);
  });
});
