import type { PrismaClient } from '@prisma/client';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { queueSectorRefresh } from '../delivery/workflow-outbox';

const KEY = 'maintenance.retire-clarifications-20260908';

/** Run before inbox/outbox workers start. Preserve evidence and elapsed pauses,
 * cancel unfinished questions, and remove their obsolete delivery jobs once. */
export async function retireClarifications(prisma: PrismaClient, now = new Date()): Promise<void> {
  await prisma.$transaction(async tx => {
    await acquireAdvisoryLock(tx, 'maintenance', KEY);
    if (await tx.systemSetting.findUnique({ where: { key: KEY } })) return;
    const incidents = await tx.incident.findMany({ where: { OR: [
      { activeClarificationId: { not: null } }, { slaPausedAt: { not: null } },
    ] } });
    for (const incident of incidents) {
      const pausedMs = incident.slaPausedAt ? Math.max(0, now.getTime() - incident.slaPausedAt.getTime()) : 0;
      const deadlineAt = new Date(incident.deadlineAt.getTime() + pausedMs);
      await tx.incident.update({ where: { id: incident.id }, data: {
        activeClarificationId: null, slaPausedAt: null, deadlineAt,
        slaPausedMs: { increment: BigInt(pausedMs) },
      } });
      await tx.incidentHistory.create({ data: { incidentId: incident.id, action: 'CLARIFICATION_RETIRED',
        metadata: { clarificationId: incident.activeClarificationId, pausedMs, deadlineAt: deadlineAt.toISOString() } } });
    }
    const cancelled = await tx.clarification.updateMany({ where: { status: { in: ['DRAFT', 'PENDING_DELIVERY', 'WAITING_REPLY'] } },
      data: { status: 'CANCELLED' } });
    await tx.operatorSession.deleteMany({ where: { type: { in: ['WAITING_CLARIFICATION_QUESTION', 'WAITING_CLARIFICATION_REPLY'] } } });
    await tx.outboundMessage.deleteMany({ where: { status: { not: 'SENT' }, OR: [
      { dedupeKey: { startsWith: 'clarification-preview:' } },
      { dedupeKey: { startsWith: 'clarification-question:' } },
      { payload: { path: ['operation', 'type'], equals: 'clarification-question' } },
    ] } });
    const open = await tx.incident.findMany({ where: { status: { in: ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'] } }, select: { id: true } });
    for (const incident of open) await queueSectorRefresh(tx, incident.id, `${KEY}:${incident.id}`);
    await tx.systemSetting.create({ data: { key: KEY, value: JSON.stringify({ completedAt: now.toISOString(), resumed: incidents.length, cancelled: cancelled.count }) } });
  }, TRANSACTION_OPTIONS);
}
