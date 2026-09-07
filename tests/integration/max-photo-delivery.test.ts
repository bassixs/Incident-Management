import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UserRole, type PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { MaxMessageService } from '../../src/max/max-message.service';
import { MediaService } from '../../src/media/media.service';
import { buildServices } from '../../src/app/container';
import { photoReference } from '../../src/media/max-photo-reference';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('MAX photo references in persistent delivery', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterAll(() => prisma.$disconnect());
  const storage = () => ({ save: vi.fn(), load: vi.fn(), remove: vi.fn() });

  it('uses MAX for registration, assignment, clarification and answers, including replacement after final delivery fails', async () => {
    const files = storage(); let counter = 0;
    const photoTokens: string[] = [];
    const send = async (target: string, _text: string, extra?: { attachments?: Array<{ type: string; payload?: { token?: string } }> }) => {
      for (const attachment of extra?.attachments ?? []) {
        if (attachment.type === 'image') {
          const token = attachment.payload!.token!;
          photoTokens.push(token);
          if (target === 'user' && token === 'answer-expired') throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
        }
      }
      return { body: { mid: `photo-flow-${++counter}` } };
    };
    const max = { sendToChat: (id: bigint, text: string, extra?: Parameters<typeof send>[2]) => send('chat', text, extra),
      sendToUser: (id: bigint, text: string, extra?: Parameters<typeof send>[2]) => send('user', text, extra),
      editMessage: async () => undefined };
    const messages = new MaxMessageService(max as never, { prisma, storage: files as never });
    const services = buildServices(prisma, { messages, media: new MediaService(files as never, max as never) });
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
    const incident = await services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Фонарь', media: [{ kind: 'IMAGE', token: 'resident' }] });
    await messages.flush();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.sector } });
    await services.distribution.assign(incident.id, group.id, actor); await messages.flush();
    const question = await services.clarifications.prepare(incident.id, actor, TEST_CHATS.sector, 'Пришлите фото поближе', 'question');
    await services.clarifications.confirm(incident.id, question.id, actor, TEST_CHATS.sector);
    await services.clarifications.reply(question.id, TEST_USERS.requesterA, 'Вот', [{ kind: 'IMAGE', token: 'clarification' }], 'reply');
    const { answer } = await services.answers.submit(incident.id, actor, 'Готово', [{ kind: 'IMAGE', token: 'answer-expired' }]);
    await messages.flush();
    await services.review.approve(incident.id, actor, answer.id); await messages.flush();
    const failed = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } });
    expect(failed.status).toBe('FAILED');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    const deadlineBeforeRepair = (await services.repository.findById(incident.id))!.deadlineAt;
    await expect(services.answers.reopenForPhotoReplacement(incident.id, failed.id, actor, TEST_CHATS.otherSector)).rejects.toThrow('профильном чате');
    await services.answers.reopenForPhotoReplacement(incident.id, failed.id, actor, TEST_CHATS.sector);
    await expect(services.answers.reopenForPhotoReplacement(incident.id, failed.id, actor, TEST_CHATS.sector)).rejects.toThrow('Кнопка устарела');
    const revised = await services.repository.findById(incident.id);
    expect(revised?.status).toBe('REVISION_REQUIRED');
    expect(revised?.deadlineAt).toEqual(deadlineBeforeRepair);
    const { answer: replacement } = await services.answers.submit(incident.id, actor, 'Готово, новое фото', [{ kind: 'IMAGE', token: 'replacement' }]);
    expect(replacement.version).toBe(answer.version + 1);
    await messages.flush();
    expect((await services.repository.findById(incident.id))?.status).toBe('WAITING_REVIEW');
    await services.review.approve(incident.id, actor, replacement.id); await messages.flush();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: replacement.id } })).deliveredAt).not.toBeNull();
    expect(photoTokens).toEqual(expect.arrayContaining(['resident', 'clarification', 'answer-expired', 'replacement']));
    const failedAttempts = photoTokens.filter(token => token === 'answer-expired').length;
    await prisma.outboundMessage.update({ where: { id: failed.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    await messages.flush();
    expect(photoTokens.filter(token => token === 'answer-expired')).toHaveLength(failedAttempts);
    for (const fn of Object.values(files)) expect(fn).not.toHaveBeenCalled();
  });

  it('restarts and retries a photo from its token with no local file operations', async () => {
    const files = storage();
    const first = new MaxMessageService({ sendToUser: async () => { throw new Error('temporary outage'); } } as never, { prisma, storage: files as never });
    expect((await first.send({ userId: 1n }, { text: 'Фото', attachments: [{ type: 'IMAGE', maxToken: 'existing' }], delivery: { dedupeKey: 'photo' } })).state).toBe('queued');
    const queued = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'photo' } });
    expect(queued.attachments).toEqual([{ type: 'IMAGE', storageKey: photoReference('existing'), owned: false }]);
    await prisma.outboundMessage.update({ where: { id: queued.id }, data: { nextAttemptAt: new Date(0) } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'sent' } });
    await new MaxMessageService({ sendToUser } as never, { prisma, storage: files as never }).flush();
    expect(sendToUser.mock.calls[0]![2].attachments).toEqual([{ type: 'image', payload: { token: 'existing' } }]);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('SENT');
    for (const fn of Object.values(files)) expect(fn).not.toHaveBeenCalled();
  });

  it('publishes an explicit incomplete distribution card on revoked photo, preserving routing buttons', async () => {
    const files = storage();
    const sent: Array<{ text: string; extra: unknown }> = [];
    const max = { sendToChat: async (_id: bigint, text: string, extra: { attachments?: Array<{ type: string }> }) => {
      if (extra.attachments?.some(a => a.type === 'image')) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
      sent.push({ text, extra }); return { body: { mid: 'fallback-card' } };
    }, sendToUser: async () => ({ body: { mid: 'thanks' } }), editMessage: async () => undefined };
    const messages = new MaxMessageService(max as never, { prisma, storage: files as never });
    const media = new MediaService(files as never, max as never);
    const services = buildServices(prisma, { messages, media });
    const incident = await services.incidents.create({ requester: { maxUserId: 7001n, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Фонарь', media: [{ kind: 'IMAGE', token: 'revoked' }] });
    await messages.flush();
    // A failed photo send defers this recipient until the next worker sweep.
    // The fallback is durable; do not require a timing-dependent single sweep.
    expect(await prisma.outboundMessage.count({ where: { incidentId: incident.id, dedupeKey: { startsWith: 'photo-recovery:' } } })).toBe(1);
    await messages.flush();
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).distributionMessageId).toBe('fallback-card');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Запросите её повторно');
    expect(sent[0]!.extra).toMatchObject({ attachments: [{ type: 'inline_keyboard' }] });
    expect(await prisma.outboundMessage.count({ where: { status: 'FAILED', incidentId: incident.id } })).toBe(1);
    for (const fn of Object.values(files)) expect(fn).not.toHaveBeenCalled();
  });

  it('a refused answer photo does not mark the complete answer delivered or offer a rating', async () => {
    const files = storage();
    const sendToUser = vi.fn().mockRejectedValueOnce(new MaxError(400, { code: 'attachment.invalid', message: 'Invalid image token' }))
      .mockResolvedValue({ body: { mid: 'notice' } });
    const messages = new MaxMessageService({ sendToUser } as never, { prisma, storage: files as never });
    const result = await messages.send({ userId: 1n }, { text: 'Ответ', attachments: [{ type: 'IMAGE', maxToken: 'expired' }],
      keyboard: [[{ type: 'callback', text: '5', payload: 'rating' }]],
      delivery: { dedupeKey: 'answer:expired', tracking: { type: 'ANSWER_TO_REQUESTER', incidentId: 'incident', answerId: 'answer' } },
    });
    expect(result.state).toBe('queued');
    await messages.flush();
    const failed = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'answer:expired' } });
    expect(failed.status).toBe('FAILED'); expect(failed.trackingApplied).toBe(false);
    const recovery = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `photo-recovery:${failed.id}` } });
    expect(recovery.trackingType).toBeNull();
    expect(recovery.payload).not.toHaveProperty('keyboard');
    expect(sendToUser.mock.calls.at(-1)![1]).toContain('Полный ответ пока не доставлен');
  });
});
