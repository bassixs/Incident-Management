import { acquireAdvisoryLock, type Tx } from '../database/prisma';
import { queueSectorRefresh } from '../delivery/workflow-outbox';

/** Called in the same transaction that marks the outgoing question delivered. */
export async function activateClarification(tx: Tx, incidentId: string, id: string): Promise<void> {
  await acquireAdvisoryLock(tx, 'incident-answer', incidentId);
  const now = new Date();
  const active = await tx.incident.updateMany({ where: { id: incidentId, activeClarificationId: id, slaPausedAt: null },
    data: { slaPausedAt: now } });
  if (!active.count) return;
  await tx.clarification.update({ where: { id }, data: { status: 'WAITING_REPLY', deliveredAt: now } });
  await tx.incidentHistory.create({ data: { incidentId, action: 'CLARIFICATION_DELIVERED', metadata: { clarificationId: id, pausedAt: now.toISOString() } } });
  await queueSectorRefresh(tx, incidentId, `clarification:${id}:waiting`);
}
