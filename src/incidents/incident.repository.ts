import { type Incident, IncidentStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { PrismaLike, Tx } from '../database/prisma';
import { formatCounterDay } from '../utils/datetime';

export const INCIDENT_INCLUDE = {
  requester: true,
  userSelectedCategory: true,
  assignedGroup: true,
  currentResponder: true,
  assignedBy: true,
  approvedBy: true,
  attachments: true,
  answers: { orderBy: { version: 'asc' }, include: { attachments: true, createdBy: true } },
} satisfies Prisma.IncidentInclude;

export type IncidentWithRelations = Prisma.IncidentGetPayload<{ include: typeof INCIDENT_INCLUDE }>;

export class IncidentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Atomically reserve the next publicCode for a day.
   *
   * A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING is atomic even
   * under parallel transactions, so two incidents can never share a number.
   */
  async nextPublicCode(tx: Tx, when: Date, timeZone?: string): Promise<string> {
    const day = formatCounterDay(when, timeZone);
    const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO "IncidentCounter" ("day", "lastNumber")
      VALUES (${day}, 1)
      ON CONFLICT ("day") DO UPDATE SET "lastNumber" = "IncidentCounter"."lastNumber" + 1
      RETURNING "lastNumber"
    `;
    const next = rows[0]?.lastNumber ?? 1;
    return `INC-${day}-${String(next).padStart(4, '0')}`;
  }

  async countCreatedBetween(tx: PrismaLike, requesterMaxUserId: bigint, start: Date, end: Date): Promise<number> {
    return tx.incident.count({
      where: { requesterMaxUserId, createdAt: { gte: start, lt: end } },
    });
  }

  async create(tx: PrismaLike, data: Prisma.IncidentUncheckedCreateInput): Promise<Incident> {
    return tx.incident.create({ data });
  }

  async findById(id: string, tx?: PrismaLike): Promise<IncidentWithRelations | null> {
    return (tx ?? this.prisma).incident.findUnique({ where: { id }, include: INCIDENT_INCLUDE });
  }

  async findByPublicCode(publicCode: string): Promise<IncidentWithRelations | null> {
    return this.prisma.incident.findUnique({
      where: { publicCode: publicCode.toUpperCase() },
      include: INCIDENT_INCLUDE,
    });
  }

  async listForRequester(requesterMaxUserId: bigint, take: number): Promise<Incident[]> {
    return this.prisma.incident.findMany({
      where: { requesterMaxUserId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async listForReport(range: { from?: Date; to?: Date }): Promise<IncidentWithRelations[]> {
    const where: Prisma.IncidentWhereInput = {};
    if (range.from || range.to) {
      where.createdAt = {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lt: range.to } : {}),
      };
    }
    return this.prisma.incident.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: INCIDENT_INCLUDE,
    });
  }

  /** Current unresolved backlog, independent of the report's creation-date range. */
  async listOverdueForReport(now: Date): Promise<IncidentWithRelations[]> {
    return this.prisma.incident.findMany({
      where: {
        status: { notIn: [IncidentStatus.RESOLVED, IncidentStatus.REJECTED] },
        deadlineAt: { lte: now },
      },
      orderBy: [{ deadlineAt: 'asc' }, { publicCode: 'asc' }],
      include: INCIDENT_INCLUDE,
    });
  }

  /**
   * Guarded status change: the UPDATE only fires when the row still has the
   * status the caller observed. Returns false when someone else got there
   * first, which is how double distribution and double approval are prevented.
   */
  async transition(
    tx: PrismaLike,
    incidentId: string,
    expected: IncidentStatus | IncidentStatus[],
    data: Prisma.IncidentUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const statuses = Array.isArray(expected) ? expected : [expected];
    const result = await tx.incident.updateMany({
      where: { id: incidentId, status: { in: statuses } },
      data,
    });
    return result.count === 1;
  }

  async update(tx: PrismaLike, incidentId: string, data: Prisma.IncidentUncheckedUpdateInput): Promise<Incident> {
    return tx.incident.update({ where: { id: incidentId }, data });
  }

  /** Active incidents whose deadline needs an SLA decision. */
  async listActiveForSla(now: Date): Promise<Incident[]> {
    const firstReminder = new Date(now.getTime() - 24 * 3_600_000);
    return this.prisma.incident.findMany({
      where: {
        status: { notIn: [IncidentStatus.RESOLVED, IncidentStatus.REJECTED] },
        OR: [{ createdAt: { lte: firstReminder } }, { deadlineAt: { lte: now } }],
      },
      orderBy: { deadlineAt: 'asc' },
    });
  }

  async latestAnswer(incidentId: string, tx?: PrismaLike) {
    return (tx ?? this.prisma).incidentAnswer.findFirst({
      where: { incidentId },
      orderBy: { version: 'desc' },
      include: { attachments: true },
    });
  }
}
