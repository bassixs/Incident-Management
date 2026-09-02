import { InboxStatus, OutboxStatus, type PrismaClient } from '@prisma/client';

export type DeliveryProblem = {
  id: string;
  reference: string;
  direction: 'outbound' | 'inbound';
  occurredAt: Date;
  incidentCode?: string | undefined;
  description: string;
  attempts: number;
  targetType?: string | undefined;
  targetId?: bigint | undefined;
  textPreview?: string | undefined;
  error?: string | undefined;
};

export type RetryFailedResult =
  | { status: 'retried'; count: number; reference?: string; incidentCode?: string | undefined }
  | { status: 'not_found' }
  | { status: 'ambiguous' };

const DESCRIPTION_BY_TRACKING = {
  DISTRIBUTION_CARD: 'карточка в чат распределения',
  SECTOR_CARD: 'карточка в профильный чат',
  REVIEW_CARD: 'ответ на согласование',
  ANSWER_TO_REQUESTER: 'ответ заявителю',
} as const;

/** Queries and safely requeues terminal delivery failures for ADMIN commands. */
export class DeliveryProblemService {
  constructor(private readonly prisma: PrismaClient) {}

  async recent(limit = 10): Promise<DeliveryProblem[]> {
    const take = Math.max(1, Math.min(limit, 20));
    const [outbound, inbound] = await Promise.all([
      this.prisma.outboundMessage.findMany({
        where: { status: OutboxStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        take,
        select: {
          id: true,
          incidentId: true,
          trackingType: true,
          targetType: true,
          targetId: true,
          payload: true,
          attempts: true,
          lastError: true,
          updatedAt: true,
        },
      }),
      this.prisma.inboundUpdate.findMany({
        where: { status: InboxStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        take,
        select: {
          id: true,
          externalUpdateKey: true,
          updateType: true,
          attempts: true,
          lastError: true,
          updatedAt: true,
        },
      }),
    ]);

    const incidentIds = [...new Set(outbound.flatMap((row) => (row.incidentId ? [row.incidentId] : [])))];
    const incidents = incidentIds.length
      ? await this.prisma.incident.findMany({
          where: { id: { in: incidentIds } },
          select: { id: true, publicCode: true },
        })
      : [];
    const codes = new Map(incidents.map((incident) => [incident.id, incident.publicCode]));

    const problems: DeliveryProblem[] = [
      ...outbound.map((row) => {
        const payload = row.payload as { text?: unknown };
        const tracking = row.trackingType ? DESCRIPTION_BY_TRACKING[row.trackingType] : undefined;
        return {
          id: row.id,
          reference: row.id.slice(0, 8),
          direction: 'outbound' as const,
          occurredAt: row.updatedAt,
          incidentCode: row.incidentId ? codes.get(row.incidentId) : undefined,
          description: tracking ?? 'исходящее сообщение',
          attempts: row.attempts,
          targetType: row.targetType,
          targetId: row.targetId,
          textPreview: typeof payload.text === 'string' ? preview(payload.text) : undefined,
          error: row.lastError ?? undefined,
        };
      }),
      ...inbound.map((row) => ({
        id: row.id,
        reference: row.id.slice(0, 8),
        direction: 'inbound' as const,
        occurredAt: row.updatedAt,
        description: `входящее событие ${row.updateType}`,
        attempts: row.attempts,
        textPreview: row.externalUpdateKey,
        error: row.lastError ?? undefined,
      })),
    ];
    return problems.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime()).slice(0, take);
  }

  async retryFailedOutbound(reference?: string): Promise<RetryFailedResult> {
    if (!reference) {
      const retried = await this.prisma.outboundMessage.updateMany({
        where: { status: OutboxStatus.FAILED },
        data: retryData(),
      });
      return { status: 'retried', count: retried.count };
    }

    const matches = await this.prisma.outboundMessage.findMany({
      where: { id: { startsWith: reference.toLowerCase() }, status: OutboxStatus.FAILED },
      take: 2,
      select: { id: true, incidentId: true },
    });
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous' };
    const match = matches[0]!;
    const updated = await this.prisma.outboundMessage.updateMany({
      where: { id: match.id, status: OutboxStatus.FAILED },
      data: retryData(),
    });
    if (updated.count !== 1) return { status: 'not_found' };
    const incident = match.incidentId
      ? await this.prisma.incident.findUnique({ where: { id: match.incidentId }, select: { publicCode: true } })
      : null;
    return {
      status: 'retried',
      count: 1,
      reference: match.id.slice(0, 8),
      incidentCode: incident?.publicCode,
    };
  }
}

function retryData() {
  return {
    status: OutboxStatus.PENDING,
    attempts: 0,
    nextAttemptAt: new Date(),
    lockedAt: null,
    lastError: null,
    deliveryAlertedAt: null,
  };
}

function preview(value: string, limit = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return Array.from(compact).length <= limit ? compact : `${Array.from(compact).slice(0, limit - 1).join('')}…`;
}
