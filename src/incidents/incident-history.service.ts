import type { IncidentStatus, PrismaClient } from '@prisma/client';

import type { PrismaLike } from '../database/prisma';

/** Canonical action names. History rows are append-only and never deleted. */
export const HistoryAction = {
  INCIDENT_CREATED: 'INCIDENT_CREATED',
  DISTRIBUTION_CARD_SENT: 'DISTRIBUTION_CARD_SENT',
  ASSIGNED: 'ASSIGNED',
  SECTOR_CARD_SENT: 'SECTOR_CARD_SENT',
  TAKEN_IN_WORK: 'TAKEN_IN_WORK',
  ANSWER_CREATED: 'ANSWER_CREATED',
  SENT_TO_REVIEW: 'SENT_TO_REVIEW',
  REVISION_REQUESTED: 'REVISION_REQUESTED',
  ANSWER_APPROVED: 'ANSWER_APPROVED',
  ANSWER_SENT: 'ANSWER_SENT',
  INCIDENT_REJECTED: 'INCIDENT_REJECTED',
  USER_BANNED: 'USER_BANNED',
  USER_UNBANNED: 'USER_UNBANNED',
  SLA_WARNING_24H: 'SLA_WARNING_24H',
  SLA_WARNING_6H: 'SLA_WARNING_6H',
  SLA_OVERDUE: 'SLA_OVERDUE',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
} as const;

export type HistoryActionName = (typeof HistoryAction)[keyof typeof HistoryAction];

export type HistoryEntry = {
  incidentId: string;
  action: HistoryActionName | string;
  fromStatus?: IncidentStatus | null;
  toStatus?: IncidentStatus | null;
  actorMaxUserId?: bigint | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown> | null;
};

export class IncidentHistoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: HistoryEntry, tx?: PrismaLike): Promise<void> {
    const client = tx ?? this.prisma;
    await client.incidentHistory.create({
      data: {
        incidentId: entry.incidentId,
        action: entry.action,
        fromStatus: entry.fromStatus ?? null,
        toStatus: entry.toStatus ?? null,
        actorMaxUserId: entry.actorMaxUserId ?? null,
        actorRole: entry.actorRole ?? null,
        metadata: (entry.metadata ?? undefined) as never,
      },
    });
  }

  async listForIncident(incidentId: string) {
    return this.prisma.incidentHistory.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
