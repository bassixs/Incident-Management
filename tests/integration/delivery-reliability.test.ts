import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { type PrismaClient, UserRole } from '@prisma/client';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('delivery reliability regressions', () => {
  let prisma: PrismaClient;
  const workers: MaxMessageService[] = [];
  const storage = { save: vi.fn(), load: vi.fn().mockResolvedValue(Buffer.from('test-file')), remove: vi.fn(), exists: vi.fn().mockResolvedValue(true) };
  function worker(max: object) {
    const w = new MaxMessageService({ editCardWithKeyboard: async () => undefined, editMessage: async () => undefined, ...max } as never, { prisma, storage });
    // Explicit sweeps make crash/retry boundaries deterministic, not timing-dependent.
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterEach(async () => { for (const w of workers) w.stop(); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());
  async function fixture() {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Test administrator', [UserRole.ADMIN]);
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Test resident', []);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.sector } });
    const incident = await prisma.incident.create({ data: { publicCode: 'INC-000001', requesterId: requester.userId,
      requesterMaxUserId: requester.maxUserId, requesterName: 'Resident', text: 'Test street light', status: 'ASSIGNED',
      assignedGroupId: group.id, deadlineAt: new Date(Date.now() + 86400000) } });
    return { actor, incident, group };
  }

  it('BASE-1 delivers photo recovery to the current sector and stores its MID', async () => {
    const { incident } = await fixture();
    const sendToChat = vi.fn(async (_id: bigint, _text: string, extra: any) => {
      if (extra.attachments?.some((x: any) => x.type === 'image')) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
      return { body: { mid: 'recovery-mid' } };
    });
    const w = worker({ sendToChat });
    await w.send({ chatId: TEST_CHATS.sector }, { text: 'Sector card', attachments: [{ type: 'IMAGE', maxToken: 'unavailable' }],
      keyboard: [[{ type: 'callback', text: 'Work', payload: `incident:take:${incident.id}` }]],
      delivery: { dedupeKey: `sector-card:${incident.id}`, tracking: { type: 'SECTOR_CARD', incidentId: incident.id } } });
    await w.flush();
    const original = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `sector-card:${incident.id}` } });
    const recovery = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `photo-recovery:${original.id}` } });
    expect(recovery.status).toBe('SENT');
    expect(recovery.firstMessageId).toBe('recovery-mid');
    expect(sendToChat.mock.calls.some(c => c[1].includes('Фотография недоступна'))).toBe(true);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBe('recovery-mid');
    expect(original.status).toBe('FAILED');
  });

  it('BASE-2 manual resend revives the latest failed approved answer', async () => {
    const { incident, actor } = await fixture();
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'APPROVED', text: 'Completed', createdByUserId: actor.userId, approvedAt: new Date() } });
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', answeredAt: new Date() } });
    const failed = await prisma.outboundMessage.create({ data: { dedupeKey: `answer:${answer.id}`, targetType: 'user', targetId: TEST_USERS.requesterA,
      status: 'FAILED', attempts: 12, lastError: '503: test outage', payload: { text: 'Approved answer' }, attachments: [],
      incidentId: incident.id, answerId: answer.id, trackingType: 'ANSWER_TO_REQUESTER' } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'answer-mid' } });
    const w = worker({ sendToUser });
    const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    await services.review.resend(incident.id);
    await w.flush();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('SENT');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).not.toBeNull();
  });

  it('BASE-3 restart resumes a long message after the confirmed first part', async () => {
    const text = 'a'.repeat(8000), parts = splitText(text); const sent: string[] = [];
    let count = 0;
    const first = worker({ sendToUser: async (_id: bigint, body: string) => {
      if (++count === 2) throw new MaxError(503, { code: 'unavailable', message: 'test outage' });
      sent.push(body); return { body: { mid: `part-${count}` } };
    } });
    await first.send({ userId: 123n }, { text, delivery: { dedupeKey: 'split-regression' } });
    first.stop(); await first.waitForIdle();
    const pending = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'split-regression' } });
    expect(pending.status).toBe('PENDING'); expect(sent).toEqual([parts[0]]);
    await prisma.outboundMessage.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(0) } });
    const next = worker({ sendToUser: async (_id: bigint, body: string) => { sent.push(body); return { body: { mid: `next-${sent.length}` } }; } });
    await next.flush();
    expect(sent).toEqual(parts);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: pending.id } })).firstMessageId).toBe('part-1');
  });
});
