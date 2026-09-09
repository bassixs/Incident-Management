import type { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { deliveryMetrics } from '../../src/reports/delivery-metrics';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

describeIntegration('read-only pilot delivery metrics', () => {
  let prisma: PrismaClient;
  const from = new Date('2026-09-09T08:00:00Z');
  const to = new Date('2026-09-09T09:00:00Z');
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(() => resetDatabase(prisma));
  afterAll(() => prisma.$disconnect());
  it('measures completed deliveries, excludes pending values and does not export message content', async () => {
    for (const [i, ms] of [1000, 3000].entries()) await prisma.outboundMessage.create({ data: {
      targetType: 'user', targetId: 1n, payload: { text: 'PRIVATE TEST TEXT' }, attachments: [], status: 'SENT',
      createdAt: from, sentAt: new Date(from.getTime() + ms), attempts: i + 1,
    } });
    await prisma.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, payload: {}, attachments: [], status: 'PENDING', createdAt: from } });
    await prisma.inboundUpdate.create({ data: { externalUpdateKey: 'metric-test', updateType: 'test', payload: {},
      status: 'PROCESSED', receivedAt: from, processedAt: new Date(from.getTime() + 2000) } });
    const result = await deliveryMetrics(prisma, from, to);
    expect(result.metrics.find(m => m.metric === 'outbox')).toMatchObject({ count: 2, averageMs: 2000, p50Ms: 2000, p95Ms: 2900, maxMs: 3000 });
    expect(result.metrics.find(m => m.metric === 'inbox')).toMatchObject({ count: 1, p95Ms: 2000 });
    expect(result.metrics.find(m => m.metric === 'answer')).toMatchObject({ count: 0, p95Ms: null });
    expect(result.outgoingWithRetries).toBe(1);
    expect(result.queues.outbox).toContainEqual({ status: 'PENDING', _count: 1 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE TEST TEXT');
    expect(await prisma.outboundMessage.count()).toBe(3);
  });
  it('validates the time interval before querying', async () => {
    await expect(deliveryMetrics(prisma, to, from)).rejects.toThrow('раньше');
  });
});
