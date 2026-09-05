import { AsyncActivity } from '../utils/async-activity';
import type { Incident, PrismaClient } from '@prisma/client';
import { TRANSACTION_OPTIONS } from '../database/prisma';
import { queueMessage } from '../delivery/workflow-outbox';
import { codeLabel } from '../bot/views/cards';
import { AppError } from '../utils/errors';

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
  private readonly activity = new AsyncActivity();
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

  async waitForIdle(): Promise<void> {
    await this.activity.waitForIdle();
  }

  async sweep(now = new Date()): Promise<SlaSweepResult> {
    return this.activity.run(() => this.sweepNow(now));
  }

  private async sweepNow(now: Date): Promise<SlaSweepResult> {
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
    const text = [
      `⚠️ ${incident.publicCode}`,
      '',
      `До окончания срока ответа осталось менее ${hours} часов.`,
      '',
      'Срок:',
      formatDateTime(incident.deadlineAt),
    ].join('\n');

    const key = `sla:${incident.id}:${hours}`;
    if (!(await this.queueWarning(incident, hours, text, key, now))) return false;
    await this.notify(incident, text, key);
    return true;
  }

  private async markOverdue(incident: Incident, now: Date): Promise<boolean> {
    const text = ['🚨 ПРОСРОЧЕНО', '', incident.publicCode, 'Срок ответа истёк.'].join('\n');
    const key = `sla:${incident.id}:overdue`;
    if (!(await this.queueWarning(incident, 0, text, key, now))) return false;
    await this.notify(incident, text, key);
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
  private async queueWarning(incident: Incident, hours: 0 | 6 | 24, text: string, key: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const field = hours === 24 ? 'slaWarn24SentAt' : hours === 6 ? 'slaWarn6SentAt' : 'overdueNotifiedAt';
      const claimed = await tx.incident.updateMany({
        where: { id: incident.id, [field]: null, status: { notIn: ['RESOLVED', 'REJECTED'] } },
        data: { [field]: now, ...(hours === 0 ? { isOverdue: true } : {}) },
      });
      if (claimed.count !== 1) return false;
      const fresh = await tx.incident.findUniqueOrThrow({ where: { id: incident.id }, include: { assignedGroup: true } });
      const chatId = fresh.assignedGroupId ? fresh.assignedGroup?.maxChatId : getConfig().DISTRIBUTION_CHAT_ID;
      if (chatId == null) throw new AppError('Рабочий чат для SLA не настроен.', 'CONFIG_MISSING');
      await this.history.record({
        incidentId: incident.id,
        action: hours === 24 ? HistoryAction.SLA_WARNING_24H : hours === 6 ? HistoryAction.SLA_WARNING_6H : HistoryAction.SLA_OVERDUE,
        metadata: { deadlineAt: incident.deadlineAt.toISOString() },
      }, tx);
      await queueMessage(tx, { chatId }, { text, label: codeLabel(incident), delivery: { dedupeKey: key } }, incident.id);
      return true;
    }, TRANSACTION_OPTIONS);
  }

  private async notify(incident: Incident, text: string, dedupeKey: string): Promise<void> {
    if (incident.assignedGroupId) {
      await this.sector.notify(incident, text, dedupeKey);
      return;
    }
    await this.distribution.notify(text, dedupeKey);
  }
}
