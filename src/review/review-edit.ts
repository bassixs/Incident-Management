import { type OperatorSession, SessionType } from '@prisma/client';
import { acquireAdvisoryLock, type Tx } from '../database/prisma';
import { REVIEW_LOCK, REVIEW_LEASE_ACTION } from '../work-queues/state';
import { ConflictError } from '../utils/errors';

/** Review corrections share the review input session and its reservation lifecycle. */
export type ReviewEditDraft = {
  reviewEdit: true;
  reviewAnswerId: string;
  leaseUntil: string;
  editStage: 'text' | 'preview';
  editToken: string;
  employeeName: string;
  text: string;
  privateWorkspaceId?: string;
};
export const staleReviewEdit = () => new ConflictError('Правка устарела или закрепление завершено. Откройте актуальную карточку согласования.');
export function reviewEditDraft(session: OperatorSession): ReviewEditDraft {
  const data = session.data as unknown as ReviewEditDraft | null;
  if (session.type !== SessionType.WAITING_REVISION_REASON || !data?.reviewEdit || !data.editToken || !data.leaseUntil) throw staleReviewEdit();
  return data;
}

/** Shared lock with approval, revision and reservation changes; compare the complete draft. */
export async function assertReviewEdit(tx: Tx, session: OperatorSession) {
  await acquireAdvisoryLock(tx, ...REVIEW_LOCK);
  const data = reviewEditDraft(session);
  const lease = await tx.actionLock.findFirst({ where: { incidentId: session.incidentId, action: REVIEW_LEASE_ACTION,
    maxUserId: session.maxUserId, lockedUntil: { equals: new Date(data.leaseUntil), gt: new Date() } } });
  const current = await tx.operatorSession.findFirst({ where: { id: session.id, expiresAt: { gt: new Date() }, data: { equals: session.data! } } });
  const incident = await tx.incident.findUnique({ where: { id: session.incidentId! }, include: { answers: { orderBy: { version: 'desc' }, take: 1, include: { attachments: true } } } });
  const answer = incident?.answers[0];
  if (!lease || !current || incident?.status !== 'WAITING_REVIEW' || answer?.id !== data.reviewAnswerId || answer.status !== 'WAITING_REVIEW') throw staleReviewEdit();
  return answer;
}

/** Never approve the old answer while the reviewer has an unsaved correction. Caller holds REVIEW_LOCK. */
export async function assertNoReviewEdit(tx: Tx, incidentId: string, maxUserId: bigint) {
  const lease = await tx.actionLock.findFirst({ where: { incidentId, action: REVIEW_LEASE_ACTION, maxUserId, lockedUntil: { gt: new Date() } } });
  if (!lease) return;
  const session = await tx.operatorSession.findFirst({ where: { incidentId, maxUserId, type: SessionType.WAITING_REVISION_REASON,
    expiresAt: { gt: new Date() }, data: { path: ['reviewEdit'], equals: true } } });
  if (session && reviewEditDraft(session).leaseUntil === lease.lockedUntil.toISOString()) {
    throw new ConflictError('Сначала сохраните или отмените правку ответа, затем согласуйте его или верните на доработку.');
  }
}
