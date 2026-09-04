import type { Incident, PrismaClient } from '@prisma/client';

import type { DistributionService } from '../distribution/distribution.service';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentRepository } from '../incidents/incident.repository';
import type { SectorService } from '../sector/sector.service';
import type { OperatorSessionService } from '../sessions/operator-session.service';
import { getConfig } from '../config';
import { formatDateTime, hoursUntil } from '../utils/datetime';
import { incidentLogFields, moduleLogger } from '../utils/logger';

const log = moduleLogger('sla');

const WARN_24H = 24;
const WARN_6H = 6;

export type SlaSweepResult = {
  checked: number;
  warned24: number;
  warned6: number;
  overdue: number;
  sessionsPurged: number;
};

/**
 * Periodic SLA supervision (§14).
 *
 * Overdue is a flag, never a status: an incident past its deadline keeps its
 * workflow status and stays open. Each notification is sent at most once
 * thanks to the persisted `slaWarn*SentAt` / `overdueNotifiedAt` marks, so a
 * restart or a second worker cannot spam a chat.
 */
export class SlaService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly history: IncidentHistoryService,
    private readonly sector: SectorService,
    private readonly distribution: DistributionService,
    private readonly sessions: OperatorSessionService,
  ) {}

  start(): void {
    const config = getConfig();
    if (!config.SLA_ENABLED) {
      log.info('SLA monitoring disabled by configuration');
      return;
    }
    const intervalMs = Math.max(1, config.SLA_CHECK_INTERVAL_MINUTES) * 60_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((error) =>
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'SLA sweep failed'),
      );
    }, intervalMs);
    this.timer.unref?.();
    log.info({ intervalMinutes: config.SLA_CHECK_INTERVAL_MINUTES }, 'SLA monitoring started');
    void this.sweep().catch((error) =>
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'initial SLA sweep failed'),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(now = new Date()): Promise<SlaSweepResult> {
    const result: SlaSweepResult = { checked: 0, warned24: 0, warned6: 0, overdue: 0, sessionsPurged: 0 };
    result.sessionsPurged = await this.sessions.purgeExpired();

    const candidates = await this.repository.listActiveForSla(now, WARN_24H);
    result.checked = candidates.length;

    for (const incident of candidates) {
      const remaining = hoursUntil(incident.deadlineAt, now);
      try {
        if (remaining <= 0) {
          if (await this.markOverdue(incident, now)) result.overdue += 1;
        } else if (remaining <= WARN_6H) {
          if (await this.warn(incident, 6, now)) result.warned6 += 1;
        } else if (remaining <= WARN_24H) {
          if (await this.warn(incident, 24, now)) result.warned24 += 1;
        }
      } catch (error) {
        log.error(
          incidentLogFields({ incidentId: incident.id, publicCode: incident.publicCode, action: 'SLA_CHECK' }),
          `SLA notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    log.debug({ ...result }, 'SLA sweep finished');
    return result;
  }

  private async warn(incident: Incident, hours: 6 | 24, now: Date): Promise<boolean> {
    const alreadySent = hours === 24 ? incident.slaWarn24SentAt : incident.slaWarn6SentAt;
    if (alreadySent) return false;

    // Claim the notification before sending so two workers cannot both send it.
    const claimed = await this.prisma.incident.updateMany({
      where: {
        id: incident.id,
        ...(hours === 24 ? { slaWarn24SentAt: null } : { slaWarn6SentAt: null }),
      },
      data: hours === 24 ? { slaWarn24SentAt: now } : { slaWarn6SentAt: now },
    });
    if (claimed.count !== 1) return false;

    const text = [
      `⚠️ ${incident.publicCode}`,
      '',
      `До окончания срока ответа осталось менее ${hours} часов.`,
      '',
      'Срок:',
      formatDateTime(incident.deadlineAt),
    ].join('\n');

    await this.notify(incident, text);
    await this.history.record({
      incidentId: incident.id,
      action: hours === 24 ? HistoryAction.SLA_WARNING_24H : HistoryAction.SLA_WARNING_6H,
      metadata: { deadlineAt: incident.deadlineAt.toISOString() },
    });
    return true;
  }

  private async markOverdue(incident: Incident, now: Date): Promise<boolean> {
    const claimed = await this.prisma.incident.updateMany({
      where: { id: incident.id, overdueNotifiedAt: null },
      // Status is deliberately untouched: работа продолжается (§14).
      data: { isOverdue: true, overdueNotifiedAt: now },
    });
    if (claimed.count !== 1) return false;

    const text = ['🚨 ПРОСРОЧЕНО', '', incident.publicCode, 'Срок ответа истёк.'].join('\n');
    await this.notify(incident, text);
    await this.history.record({
      incidentId: incident.id,
      action: HistoryAction.SLA_OVERDUE,
      metadata: { deadlineAt: incident.deadlineAt.toISOString() },
    });
    log.warn(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        action: HistoryAction.SLA_OVERDUE,
      }),
      'incident is overdue',
    );
    return true;
  }

  /** Warnings go where the work is: the sector chat, or distribution if unrouted. */
  private async notify(incident: Incident, text: string): Promise<void> {
    if (incident.assignedGroupId) {
      await this.sector.notify(incident, text);
      return;
    }
    await this.distribution.notify(text);
  }
}
