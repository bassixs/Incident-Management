import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { buildServices, type AppServices } from '../../src/app/container';
import * as outbox from '../../src/delivery/workflow-outbox';
import { MaxMessageService } from '../../src/max/max-message.service';
import { photoReference } from '../../src/media/max-photo-reference';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_USERS } from '../helpers/setup-env';

describeIntegration('sector card status through durable delivery', () => {
  let prisma: PrismaClient;
  let services: AppServices;
  let worker: MaxMessageService;
  let sequence: number;
  let failAnswer: boolean;
  let failEdit: boolean;
  const cards = new Map<string, string>();
  const edits = vi.fn(async (id: string, text: string, _attachments?: unknown) => {
    if (failEdit) throw new Error('Temporary edit failure');
    cards.set(id, text);
  });
  const sendToChat = vi.fn(async (_id: bigint, text: string) => {
    const mid = `chat-${++sequence}`;
    cards.set(mid, text);
    return { body: { mid } };
  });
  const sendToUser = vi.fn(async (_id: bigint, text: string) => {
    if (failAnswer && text.includes('Получен ответ')) throw new Error('Temporary delivery failure');
    return { body: { mid: `user-${++sequence}` } };
  });
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    sequence = 0; failAnswer = false; failEdit = false; cards.clear();
    edits.mockClear(); sendToChat.mockClear(); sendToUser.mockClear();
    worker = new MaxMessageService({ editMessage: edits, editCardWithKeyboard: edits, sendToChat, sendToUser } as never,
      { prisma, storage: {} as never });
    services = buildServices(prisma, { messages: worker, media: new FakeMediaService() as never });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => prisma.$disconnect());
  const actor = () => actorFor(prisma, TEST_USERS.admin, 'Сотрудник', [UserRole.ADMIN]);
  async function assigned(direct = false) {
    const incident = await services.incidents.create({
      requester: { maxUserId: TEST_USERS.requesterA, name: 'Тестовый житель', phone: '+79001234567' },
      text: 'Не горит фонарь',
    });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: direct ? GROUP_CODES.regional : GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, await actor());
    await worker.flush();
    return incident;
  }
  async function card(id: string) {
    const incident = await prisma.incident.findUniqueOrThrow({ where: { id } });
    return cards.get(incident.sectorMessageId!);
  }

  it('updates the same card through assignment, work, review, revision and delivery', async () => {
    const incident = await assigned();
    const original = (await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId;
    expect(await card(incident.id)).toMatch(/^🔴 СВОБОДНОЕ/);
    await services.sector.takeInWork(incident.id, await actor());
    expect(await card(incident.id)).toMatch(/^🟡 В РАБОТЕ/);
    expect(edits.mock.calls.filter(([id]) => id === original).at(-1)?.[2]).toEqual([[expect.objectContaining({ text: 'Подготовить ответ' })], [expect.objectContaining({ text: 'Вернуть на перераспределение' })], [expect.objectContaining({ text: 'Освободить обращение' })]]);
    expect(await card(incident.id)).toContain('👤 Исполнитель:\nСотрудник');
    await services.answers.submit(incident.id, await actor(), 'Первый ответ');
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🔵 НА СОГЛАСОВАНИИ/);
    expect(edits.mock.calls.filter(([id]) => id === original).at(-1)?.[2]).toEqual([]);
    await services.review.requestRevision(incident.id, 'Добавьте сведения', await actor());
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🟠 НА ДОРАБОТКЕ/);
    expect(edits.mock.calls.filter(([id]) => id === original).at(-1)?.[2]).toEqual([[expect.objectContaining({ text: 'Исправить ответ' })], [expect.objectContaining({ text: 'Вернуть на перераспределение' })], [expect.objectContaining({ text: 'Освободить обращение' })]]);
    await services.sector.takeInWork(incident.id, await actor());
    expect(await card(incident.id)).toMatch(/^🟡 В РАБОТЕ/);
    await services.answers.submit(incident.id, await actor(), 'Исправленный ответ');
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🔵 НА СОГЛАСОВАНИИ/);
    await services.review.approve(incident.id, await actor());
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🟢 ОТРАБОТАНО/);
    expect(edits.mock.calls.filter(([id]) => id === original).at(-1)?.[2]).toEqual([]);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBe(original);
    expect(await prisma.outboundMessage.count({ where: { status: { in: ['PENDING', 'FAILED'] } } })).toBe(0);
  });

  it.each([false, true])('waits for confirmed delivery, including a direct answer: %s', async direct => {
    const incident = await assigned(direct);
    failAnswer = true;
    await services.answers.submit(incident.id, await actor(), 'Ответ жителю');
    if (!direct) await services.review.approve(incident.id, await actor());
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^⏳ ОЖИДАЕТ ДОСТАВКИ/);
    failAnswer = false;
    await prisma.outboundMessage.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🟢 ОТРАБОТАНО/);
    if (direct) expect(sendToChat.mock.calls.some(([, text]) => text.includes('ОТВЕТ НА СОГЛАСОВАНИЕ'))).toBe(false);
  });

  it('retries an old edit with the current status and preserves MAX photos without reading storage', async () => {
    const incident = await assigned();
    // A text update must not load a legacy file or re-upload the original photo.
    await prisma.incidentAttachment.create({ data: { incidentId: incident.id, type: 'IMAGE',
      storageKey: photoReference('resident-photo-token'), originalName: 'photo.jpg' } });
    failEdit = true;
    await services.sector.takeInWork(incident.id, await actor());
    expect(await card(incident.id)).toMatch(/^🔴 СВОБОДНОЕ/);
    await services.answers.submit(incident.id, await actor(), 'Готовый ответ');
    failEdit = false;
    await prisma.outboundMessage.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🔵 НА СОГЛАСОВАНИИ/);
    const mid = (await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId;
    expect(edits.mock.calls.filter(([id]) => id === mid).at(-1)?.[2]).toEqual([]);
    expect(await prisma.outboundMessage.count({ where: { status: { in: ['PENDING', 'FAILED'] } } })).toBe(0);
  });

  it('rolls back taking work if its status update cannot be saved', async () => {
    const incident = await assigned();
    vi.spyOn(outbox, 'queueSectorRefresh').mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(services.sector.takeInWork(incident.id, await actor())).rejects.toThrow('Queue unavailable');
    const stored = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(stored.status).toBe('ASSIGNED');
    expect(stored.currentResponderId).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'TAKEN_IN_WORK' } })).toBe(0);
  });

  it('refreshes an original card whose publication finished after a status change', async () => {
    const incident = await assigned();
    await prisma.incident.update({ where: { id: incident.id }, data: { sectorMessageId: null } });
    await prisma.outboundMessage.update({ where: { dedupeKey: `sector-card:${incident.id}` },
      data: { status: 'PENDING', nextAttemptAt: new Date(0), firstMessageId: null, trackingApplied: false } });
    // Simulate a transition before MAX has returned the original card's message id.
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'WAITING_REVIEW' } });
    await worker.flush();
    expect(await card(incident.id)).toMatch(/^🔵 НА СОГЛАСОВАНИИ/);
  });
});
