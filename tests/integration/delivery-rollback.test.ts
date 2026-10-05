import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient, type OutboxStatus } from '@prisma/client';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { actorFor, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';

const sql = readFileSync('tools/delivery-rollback-preview.sql', 'utf8');
const query = sql.split('-- BEGIN PREVIEW QUERY')[1]!.split('-- END PREVIEW QUERY')[0]!.trim();
describeIntegration('rollback with persisted multipart progress', () => {
  let prisma: PrismaClient; const workers: MaxMessageService[] = [];
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(() => resetDatabase(prisma));
  afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());
  async function preview() {
    return prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      return tx.$queryRawUnsafe<Array<{ id: string; assessment: string }>>(query);
    }, { isolationLevel: 'RepeatableRead' });
  }
  async function fixture(status: OutboxStatus, count: number) {
    const text = 'x'.repeat(5000), parts = splitText(text);
    const mids = Array.from({ length: count }, (_, n) => `confirmed-${n}`);
    const planHash = createHash('sha256').update(JSON.stringify({ parts, target: 'user:1', attachments: [] })).digest('hex');
    const row = await prisma.outboundMessage.create({ data: { status, targetType: 'user', targetId: 1n, attachments: [],
      attempts: 2, lockedAt: status === 'SENDING' ? new Date(0) : null, firstMessageId: mids[0] ?? null,
      trackingApplied: status === 'SENT', sentAt: status === 'SENT' ? new Date() : null,
      payload: { text, deliveryProgress: { version: 1, planHash, totalParts: parts.length, mids } } } });
    return { row, parts, mids };
  }
  function worker() {
    const send = vi.fn(async () => ({ body: { mid: 'replacement-part' } }));
    const chat = vi.fn(async (_id: bigint, _text: string) => ({ body: { mid: 'staff-notice' } }));
    const w = new MaxMessageService({ sendToUser: send, sendToChat: chat, editCardWithKeyboard: async () => undefined } as never, { prisma, storage: {} as never });
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return { w, send, chat };
  }
  it('empty queue and only completed progress have no unfinished sends; preview changes nothing', async () => {
    expect(await preview()).toEqual([]);
    const { row } = await fixture('SENT', 2); const before = await prisma.outboundMessage.findMany();
    expect(await preview()).toEqual([expect.objectContaining({ id: row.id, assessment: 'COMPLETED_PROGRESS' })]);
    const { w, send } = worker(); await w.flush(); expect(send).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findMany()).toEqual(before);
  });
  it.each(['PENDING', 'SENDING'] as const)('blocks rollback for %s partial progress; a compatible worker sends only the remainder', async status => {
    const { row, parts, mids } = await fixture(status, 1);
    expect((await preview())[0]?.assessment).toBe('BLOCK_ACTIVE_PARTIAL');
    const before = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    await preview(); expect(await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
    const { w, send } = worker(); await w.flush();
    expect(send.mock.calls.map(c => (c as unknown[])[1])).toEqual(parts.slice(1));
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'SENT', firstMessageId: mids[0] });
  });
  it('FAILED partial progress is retained, blocks rollback, and is not retried automatically', async () => {
    const { row, parts, mids } = await fixture('FAILED', 1);
    expect((await preview())[0]?.assessment).toBe('BLOCK_FAILED_PARTIAL');
    const { w, send } = worker(); await w.flush(); expect(send).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toEqual(row);
    // Fixture-only explicit retry demonstrates why a dormant FAILED also blocks old runtime.
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    await w.flush(); expect(send.mock.calls.map(c => (c as unknown[])[1])).toEqual(parts.slice(1));
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ firstMessageId: mids[0], status: 'SENT' });
  });
  it('all parts ACKed but not finalized still blocks old runtime; compatible completion sends nothing', async () => {
    const { row, mids } = await fixture('SENDING', 2);
    expect((await preview())[0]?.assessment).toBe('BLOCK_ALL_ACKED_NOT_COMPLETED');
    const { w, send } = worker(); await w.flush(); expect(send).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ firstMessageId: mids[0], status: 'SENT', trackingApplied: true });
  });
  it('finalizes a fully ACKed approved answer without sending it again; records tracking and staff notice once', async () => {
    await seedCategories(prisma);
    const actor = await actorFor(prisma, 1n, 'Test actor', []);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.regional } });
    const incident = await prisma.incident.create({ data: { publicCode: 'INC-000001', requesterId: actor.userId, requesterMaxUserId: 1n,
      requesterName: 'Test actor', deadlineAt: new Date(), text: 'Test', status: 'RESOLVED', assignedGroupId: group.id, answeredAt: new Date() } });
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'APPROVED', text: 'Completed', createdByUserId: actor.userId, approvedAt: new Date() } });
    const { row } = await fixture('SENDING', 2);
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { incidentId: incident.id, answerId: answer.id, trackingType: 'ANSWER_TO_REQUESTER', dedupeKey: `answer:${answer.id}` } });
    expect((await preview())[0]?.assessment).toBe('BLOCK_ALL_ACKED_NOT_COMPLETED');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    const { w, send, chat } = worker(); await w.flush(); await w.flush();
    expect(send).not.toHaveBeenCalled();
    const deliveredAt = (await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt;
    expect(deliveredAt).not.toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_SENT' } })).toBe(1);
    expect(chat.mock.calls.filter(c => c[1].includes('доставлен пользователю'))).toHaveLength(1);
    w.stop(); await w.waitForIdle(); const next = worker(); await next.w.flush();
    expect(next.send).not.toHaveBeenCalled(); expect(next.chat).not.toHaveBeenCalled();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toEqual(deliveredAt);
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_SENT' } })).toBe(1);
  });
  it('unknown/corrupt progress and inconsistent SENT fail closed; absence of progress is not proof of absence of a lost ACK', async () => {
    const variants = [
      { payload: { text: 'test' }, status: 'PENDING', assessment: 'NO_PROGRESS_REQUIRES_REVIEW' },
      { payload: { text: 'test', deliveryProgress: null }, status: 'FAILED', assessment: 'BLOCK_INVALID_PROGRESS' },
      { payload: { text: 'test', deliveryProgress: { version: 2 } }, status: 'FAILED', assessment: 'BLOCK_INVALID_PROGRESS' },
    ] as const;
    for (const v of variants) {
      const row = await prisma.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, attachments: [], status: v.status, payload: v.payload as Prisma.InputJsonValue } });
      expect((await preview()).find(p => p.id === row.id)?.assessment).toBe(v.assessment);
    }
    const { row } = await fixture('SENT', 1);
    expect((await preview()).find(p => p.id === row.id)?.assessment).toBe('BLOCK_INCONSISTENT_SENT');
  });
});
