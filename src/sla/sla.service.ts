import { AsyncActivity } from '../utils/async-activity';
import { legacyOpen, workingOpen } from './policy';
import { policyWorkingHours } from './working-time';
import { workingDeadlineNotification, workingDeadlineTargets } from './working-notification';
import { workingHours } from '../utils/work-calendar';
import type { Incident, PrismaClient } from '@prisma/client';
import { TRANSACTION_OPTIONS } from '../database/prisma';
import { queueMessage } from '../delivery/workflow-outbox';
import type { MaxMessageService } from '../max/max-message.service';
import { slaNotification, slaStage } from './sla-notification';

import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentRepository } from '../incidents/incident.repository';
import type { OperatorSessionService } from '../sessions/operator-session.service';
import { getConfig } from '../config';
import { incidentLogFields, moduleLogger } from '../utils/logger';

const log = moduleLogger('sla');

export type SlaSweepResult = {
  checked: number;
  warned24: number;
  warned48: number;
  overdue: number;
  sessionsPurged: number;
};

/**
 * Periodic SLA supervision (§14).
 *
 * Overdue is a flag, never a status: an incident past its deadline keeps its
 * workflow status and stays open. A single reminder becomes due after 24 elapsed
 * hours. The persisted claim and durable delivery survive restarts/concurrency;
 * legacy notification marks suppress another reminder after an upgrade.
 */
export class SlaService {
  private readonly activity = new AsyncActivity();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly history: IncidentHistoryService,
    private readonly messages: MaxMessageService,
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
    const result: SlaSweepResult = { checked: 0, warned24: 0, warned48: 0, overdue: 0, sessionsPurged: 0 };
    result.sessionsPurged = await this.sessions.purgeExpired();

    // Expiration is visible in cards/reports immediately, even after closing.
    // Only the notification waits until employees are working again.
    await this.prisma.incident.updateMany({ where: {
      OR: [legacyOpen, workingOpen],
      deadlineAt: { lte: now }, isOverdue: false,
    }, data: { isOverdue: true } });
    if (policyWorkingHours(now)) {
      const due = await this.prisma.incident.findMany({ where: { ...workingOpen, deadlineAt: { lte: now }, workingDeadlineQueuedAt: null } });
      for (const incident of due) await this.queueWorkingDeadline(incident, now);
    }
    if (!workingHours(now)) return result;

    const candidates = await this.repository.listActiveForSla(now);
    result.checked = candidates.length;

    for (const incident of candidates) {
      const stage = slaStage(incident, now);
      try {
        if (stage !== undefined && await this.queueWarning(incident, stage, now)) {
          result.warned24 += 1;
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

  private async queueWorkingDeadline(incident: Incident, now: Date): Promise<void> {
    const targets = workingDeadlineTargets();
    if (!targets.length) return;
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.incident.updateMany({ where: { ...workingOpen, id: incident.id, deadlineAt: { lte: now }, workingDeadlineQueuedAt: null },
        data: { workingDeadlineQueuedAt: now } });
      if (claimed.count !== 1) return;
      const fresh = await tx.incident.findUniqueOrThrow({ where: { id: incident.id } });
      for (const chatId of targets) await queueMessage(tx, { chatId }, {
        text: workingDeadlineNotification(fresh), operation: { type: 'working-deadline', incidentId: incident.id },
        delivery: { dedupeKey: `sla-working-v1:${incident.id}:${chatId}` },
      }, incident.id);
      await this.history.record({ incidentId: incident.id, action: 'SLA_WORKING_DEADLINE_QUEUED',
        metadata: { deadlineAt: incident.deadlineAt.toISOString(), policy: incident.slaPolicy } }, tx);
    }, TRANSACTION_OPTIONS);
    this.messages.wake();
  }

  /** Atomically claim the only reminder together with its history and delivery. */
  private async queueWarning(incident: Incident, stage: 24, now: Date): Promise<boolean> {
    const notification = await this.prisma.$transaction(async tx => {
      const claimed = await tx.incident.updateMany({
        where: { id: incident.id, slaPolicy: 'LEGACY', slaReminder24SentAt: null, slaWarn24SentAt: null, slaWarn6SentAt: null, overdueNotifiedAt: null, slaPausedAt: null, status: { notIn: ['RESOLVED', 'REJECTED'] } },
        data: { slaReminder24SentAt: now },
      });
      if (claimed.count !== 1) return null;
      const fresh = await tx.incident.findUniqueOrThrow({ where: { id: incident.id }, include: { assignedGroup: true, currentResponder: true } });
      const prepared = slaNotification(fresh, stage);
      await this.history.record({
        incidentId: incident.id,
        action: HistoryAction.SLA_REMINDER_24H,
        metadata: { deadlineAt: fresh.deadlineAt.toISOString(), stage },
      }, tx);
      await queueMessage(tx, prepared.target, prepared.message, incident.id);
      return prepared;
    }, TRANSACTION_OPTIONS);
    if (!notification) return false;
    await this.messages.send(notification.target, notification.message);
    return true;
  }
}
