import { Prisma, type PrismaClient } from '@prisma/client';

export const DELIVERY_METRIC_LABELS = {
  inbox: 'Получение события → окончание обработки',
  outbox: 'Сохранение задания → успешная отправка (включая ожидание и повторы)',
  registration: 'Регистрация обращения → карточка распределения',
  sector: 'Регистрация → профильный чат (включая работу распределителя)',
  answer: 'Согласование / готовность прямого ответа → доставка жителю',
} as const;
type Metric = { metric: keyof typeof DELIVERY_METRIC_LABELS; count: number; averageMs: number; p50Ms: number; p95Ms: number; maxMs: number };

/** Read-only aggregates. No requester names, contacts, texts or media leave the DB. */
export async function deliveryMetrics(prisma: PrismaClient, from: Date, to = new Date()) {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Начало периода должно быть раньше конца.');
  return prisma.$transaction(async tx => {
    const metrics = await tx.$queryRaw<Metric[]>(Prisma.sql`
      WITH durations AS (
        SELECT 'inbox' AS metric, EXTRACT(EPOCH FROM ("processedAt" - "receivedAt")) * 1000 AS ms
        FROM "InboundUpdate" WHERE "receivedAt" >= ${from} AND "receivedAt" < ${to} AND "status" = 'PROCESSED'
        UNION ALL
        SELECT 'outbox', EXTRACT(EPOCH FROM ("sentAt" - "createdAt")) * 1000
        FROM "OutboundMessage" WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "status" = 'SENT'
        UNION ALL
        SELECT 'registration', EXTRACT(EPOCH FROM (o."sentAt" - i."createdAt")) * 1000
        FROM "Incident" i JOIN "OutboundMessage" o ON o."incidentId" = i.id
        WHERE i."createdAt" >= ${from} AND i."createdAt" < ${to} AND o."trackingType" = 'DISTRIBUTION_CARD' AND o.status = 'SENT'
        UNION ALL
        SELECT 'sector', EXTRACT(EPOCH FROM (o."sentAt" - i."createdAt")) * 1000
        FROM "Incident" i JOIN "OutboundMessage" o ON o."incidentId" = i.id
        WHERE i."createdAt" >= ${from} AND i."createdAt" < ${to} AND o."trackingType" = 'SECTOR_CARD' AND o.status = 'SENT'
        UNION ALL
        SELECT 'answer', EXTRACT(EPOCH FROM ("deliveredAt" - "approvedAt")) * 1000
        FROM "IncidentAnswer" WHERE "approvedAt" >= ${from} AND "approvedAt" < ${to} AND "deliveredAt" IS NOT NULL
      )
      SELECT metric, COUNT(*)::int AS count, AVG(ms)::float8 AS "averageMs",
        percentile_cont(0.50) WITHIN GROUP (ORDER BY ms)::float8 AS "p50Ms",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::float8 AS "p95Ms", MAX(ms)::float8 AS "maxMs"
      FROM durations WHERE ms >= 0 GROUP BY metric ORDER BY metric
    `);
    const [inbox, outbox, retryCount, waitingAnswers, oldestIn, oldestOut] = await Promise.all([
      tx.inboundUpdate.groupBy({ by: ['status'], _count: true }),
      tx.outboundMessage.groupBy({ by: ['status'], _count: true }),
      tx.outboundMessage.count({ where: { createdAt: { gte: from, lt: to }, attempts: { gt: 1 } } }),
      tx.incidentAnswer.count({ where: { status: 'APPROVED', deliveredAt: null } }),
      tx.inboundUpdate.findFirst({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
      tx.outboundMessage.findFirst({ where: { status: { in: ['PENDING', 'SENDING'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return {
      from: from.toISOString(), to: to.toISOString(), observedAt: new Date().toISOString(),
      metrics: Object.entries(DELIVERY_METRIC_LABELS).map(([metric, label]) => ({
        ...(metrics.find(row => row.metric === metric) ?? { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null }), metric, label })),
      queues: { inbox, outbox, oldestIncomingAt: oldestIn?.receivedAt ?? null, oldestOutgoingAt: oldestOut?.createdAt ?? null, waitingAnswers },
      outgoingWithRetries: retryCount,
      note: 'Задержки включают обработку, очередь и повторы; это не замер чистого времени сети MAX. Нулевое число наблюдений означает отсутствие данных. Очереди показаны на момент снятия, независимо от периода.',
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
