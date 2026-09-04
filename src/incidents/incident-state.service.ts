import { IncidentStatus } from '@prisma/client';

import { InvalidTransitionError } from '../utils/errors';

/**
 * The only place that decides whether a status change is legal.
 *
 * Overdue is deliberately NOT a status: an incident past its deadline keeps its
 * workflow status and carries `isOverdue = true`, so work continues normally.
 */
const ALLOWED: Record<IncidentStatus, IncidentStatus[]> = {
  [IncidentStatus.NEW]: [IncidentStatus.DISTRIBUTION],
  [IncidentStatus.DISTRIBUTION]: [IncidentStatus.ASSIGNED, IncidentStatus.REJECTED],
  [IncidentStatus.ASSIGNED]: [
    IncidentStatus.IN_PROGRESS,
    IncidentStatus.WAITING_REVIEW,
    IncidentStatus.RESOLVED,
  ],
  [IncidentStatus.IN_PROGRESS]: [IncidentStatus.WAITING_REVIEW, IncidentStatus.RESOLVED],
  [IncidentStatus.WAITING_REVIEW]: [IncidentStatus.RESOLVED, IncidentStatus.REVISION_REQUIRED],
  // A responder may resubmit straight from REVISION_REQUIRED; taking the
  // incident back into work first is optional, not required.
  [IncidentStatus.REVISION_REQUIRED]: [
    IncidentStatus.IN_PROGRESS,
    IncidentStatus.WAITING_REVIEW,
    IncidentStatus.RESOLVED,
  ],
  [IncidentStatus.REJECTED]: [],
  [IncidentStatus.RESOLVED]: [],
};

const TERMINAL: IncidentStatus[] = [IncidentStatus.REJECTED, IncidentStatus.RESOLVED];

export class IncidentStateService {
  canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
    return ALLOWED[from].includes(to);
  }

  assertTransition(from: IncidentStatus, to: IncidentStatus, context?: Record<string, unknown>): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidTransitionError(`Переход ${from} → ${to} не разрешён.`, { from, to, ...context });
    }
  }

  isTerminal(status: IncidentStatus): boolean {
    return TERMINAL.includes(status);
  }

  /** Statuses that still consume SLA attention. */
  isActive(status: IncidentStatus): boolean {
    return !this.isTerminal(status);
  }

  allowedFrom(status: IncidentStatus): IncidentStatus[] {
    return [...ALLOWED[status]];
  }
}

export const RUSSIAN_STATUS: Record<IncidentStatus, string> = {
  [IncidentStatus.NEW]: 'Создано',
  [IncidentStatus.DISTRIBUTION]: 'На распределении',
  [IncidentStatus.ASSIGNED]: 'Распределено',
  [IncidentStatus.IN_PROGRESS]: 'В работе',
  [IncidentStatus.WAITING_REVIEW]: 'На согласовании',
  [IncidentStatus.REVISION_REQUIRED]: 'На доработке',
  [IncidentStatus.REJECTED]: 'Отклонено',
  [IncidentStatus.RESOLVED]: 'Ответ получен',
};

export function describeStatus(status: IncidentStatus, isOverdue = false): string {
  return isOverdue ? `${RUSSIAN_STATUS[status]} (просрочено)` : RUSSIAN_STATUS[status];
}
