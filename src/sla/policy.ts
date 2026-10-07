import type { Incident, IncidentAssignmentCycle, Prisma } from '@prisma/client';
import type { Tx } from '../database/prisma';
import { addWorkingHours, workingMilliseconds } from './working-time';
import { formatMoscowDateTime } from '../utils/datetime';

export const WORKING_POLICY = 'WORKING_HOURS_V1' as const;
export const isWorkingPolicy = (incident: { slaPolicy?: string }) => incident.slaPolicy === WORKING_POLICY;
export const workingOpen: Prisma.IncidentWhereInput = { slaPolicy: WORKING_POLICY, status: { not: 'REJECTED' }, slaDeliveredAt: null };
export const legacyOpen: Prisma.IncidentWhereInput = { slaPolicy: 'LEGACY', status: { notIn: ['RESOLVED', 'REJECTED'] }, slaPausedAt: null };

export async function startAssignment(tx: Tx, incident: Incident, group: { id: string; code: string; name: string }, at: Date): Promise<void> {
  if (!isWorkingPolicy(incident)) return;
  const previous = await tx.incidentAssignmentCycle.findFirst({ where: { incidentId: incident.id }, orderBy: { sequence: 'desc' } });
  if (previous && !previous.endedAt) throw new Error('SLA_ASSIGNMENT_CYCLE_STILL_OPEN');
  await tx.incidentAssignmentCycle.create({ data: { incidentId: incident.id, sequence: (previous?.sequence ?? 0) + 1,
    groupId: group.id, groupCode: group.code, groupName: group.name, assignedAt: at,
    preparationDueAt: addWorkingHours(at, 22), returnDueAt: addWorkingHours(at, 2) } });
}

export async function recordPreparation(tx: Tx, incident: Incident, answerId: string, at: Date): Promise<void> {
  if (!isWorkingPolicy(incident)) return;
  const cycle = await tx.incidentAssignmentCycle.findFirst({ where: { incidentId: incident.id, endedAt: null } });
  if (!cycle) throw new Error('SLA_ASSIGNMENT_CYCLE_MISSING');
  await tx.incidentAssignmentCycle.updateMany({ where: { id: cycle.id, firstPreparedAt: null },
    data: { firstPreparedAt: at, firstPreparedAnswerId: answerId } });
  // Every submission is recorded, including rework; the first completion never moves.
  await tx.incidentHistory.create({ data: { incidentId: incident.id, action: 'SLA_PROJECT_SUBMITTED',
    metadata: { cycleId: cycle.id, answerId, submittedAt: at.toISOString() } } });
}

export async function finishAssignment(tx: Tx, incidentId: string, at: Date, outcome: string, reason?: string): Promise<void> {
  await tx.incidentAssignmentCycle.updateMany({ where: { incidentId, endedAt: null },
    data: { endedAt: at, outcome, ...(outcome === 'RETURNED' ? { returnedAt: at, returnReason: reason } : {}) } });
}

export async function recordPolicyDelivery(tx: Tx, incidentId: string, at: Date): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId } });
  if (!isWorkingPolicy(incident)) return;
  await tx.incident.update({ where: { id: incidentId }, data: { slaDeliveredAt: at, isOverdue: workingMilliseconds(incident.deadlineAt, at) > 0 } });
  await finishAssignment(tx, incidentId, at, 'DELIVERED');
}

export function policyDeliveryState(incident: Pick<Incident, 'status' | 'slaDeliveredAt'>): string {
  if (incident.status === 'REJECTED') return 'Отклонено; доставка уведомления учитывается отдельно';
  if (incident.slaDeliveredAt) return 'Актуальный ответ доставлен (подтверждение MAX, не прочтение)';
  if (incident.status === 'RESOLVED') return 'Ответ согласован/подготовлен, но доставка не завершена';
  if (incident.status === 'WAITING_REVIEW') return 'Проект передан на согласование; итоговый ответ ещё не согласован';
  return 'Актуальный итоговый ответ ещё не подготовлен или не согласован';
}

/** Call only from dispatcher/reviewer views, never according to actor roles. */
export function policyCardLines(incident: Incident & { assignmentCycles?: IncidentAssignmentCycle[] }): string[] {
  if (!isWorkingPolicy(incident)) return [];
  const cycle = incident.assignmentCycles?.at(-1);
  return ['', `Общий срок (24 рабочих часа): ${formatMoscowDateTime(incident.deadlineAt)} МСК`,
    policyDeliveryState(incident), ...(cycle ? [
      ...(cycle.endedAt ? [`Предыдущий завершённый цикл назначения №${cycle.sequence}: ${cycle.outcome}`] : []),
      `Проект (22 рабочих часа от назначения): ${formatMoscowDateTime(cycle.preparationDueAt)} МСК`,
      ...(cycle.firstPreparedAt ? [`Первая передача проекта: ${formatMoscowDateTime(cycle.firstPreparedAt)} МСК`] : []),
      ...(cycle.preparationDueAt > incident.deadlineAt ? ['⚠️ Срок подготовки проекта позже общего срока ответа. Общий срок не продлевается.'] : []),
    ] : [])];
}
