import { InboxStatus, OutboxStatus, type PrismaClient } from '@prisma/client';

import type { MaxClient } from '../max/max-client';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('delivery-alerts');
const ALERT_INTERVAL_MS = 60_000;
const BATCH_SIZE = 20;

/**
 * Reports terminal delivery failures to one technical MAX chat.
 *
 * Alerts bypass the regular outbox deliberately: a failed alert must never
 * create another alert about itself. Rows are marked only after MAX accepts
 * the notification, so an outage is reported automatically after MAX recovers.
 */
export class DeliveryAlertService {
  private timer?: NodeJS.Timeout;
  private sweepPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
    private readonly chatId: bigint | undefined,
  ) {}

  start(): void {
    if (this.chatId === undefined || this.timer) return;
    this.timer = setInterval(() => this.schedule(), ALERT_INTERVAL_MS);
    this.timer.unref?.();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.sweepPromise;
  }

  async checkNow(): Promise<void> {
    await this.kick();
  }

  private schedule(): void {
    void this.kick().catch((error) =>
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'delivery alert sweep failed',
      ),
    );
  }

  private async kick(): Promise<void> {
    if (this.chatId === undefined) return;
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.sweep().finally(() => {
      this.sweepPromise = undefined;
    });
    return this.sweepPromise;
  }

  private async sweep(): Promise<void> {
    const chatId = this.chatId;
    if (chatId === undefined) return;
    const [outbound, inbound] = await Promise.all([
      this.prisma.outboundMessage.findMany({
        where: { status: OutboxStatus.FAILED, deliveryAlertedAt: null },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, incidentId: true, attempts: true },
      }),
      this.prisma.inboundUpdate.findMany({
        where: { status: InboxStatus.FAILED, deliveryAlertedAt: null },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, updateType: true },
      }),
    ]);
    if (outbound.length === 0 && inbound.length === 0) return;

    const incidentIds = [...new Set(outbound.flatMap((row) => (row.incidentId ? [row.incidentId] : [])))];
    const incidents = incidentIds.length
      ? await this.prisma.incident.findMany({
          where: { id: { in: incidentIds } },
          select: { id: true, publicCode: true },
        })
      : [];
    const codes = new Map(incidents.map((incident) => [incident.id, incident.publicCode]));
    const lines = [
      '🚨 Обнаружена проблема с доставкой',
      '',
      `Исходящие сообщения: ${outbound.length}`,
      `Входящие события: ${inbound.length}`,
    ];

    if (outbound.length > 0) {
      lines.push('', 'Не доставлены:');
      for (const row of outbound.slice(0, 5)) {
        const label = row.incidentId ? (codes.get(row.incidentId) ?? 'обращение') : 'служебное сообщение';
        lines.push(`• ${label}, попыток: ${row.attempts}`);
      }
      if (outbound.length > 5) lines.push(`• и ещё ${outbound.length - 5}`);
    }
    if (inbound.length > 0) {
      lines.push('', 'Не обработаны входящие события:');
      for (const row of inbound.slice(0, 5)) lines.push(`• ${row.updateType}`);
      if (inbound.length > 5) lines.push(`• и ещё ${inbound.length - 5}`);
    }
    lines.push('', 'Подробности: /delivery_errors', 'Состояние очередей: /delivery_status');

    try {
      await this.max.sendToChat(chatId, lines.join('\n'));
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to send delivery alert; will retry',
      );
      return;
    }

    const notifiedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.outboundMessage.updateMany({
        where: { id: { in: outbound.map((row) => row.id) }, deliveryAlertedAt: null },
        data: { deliveryAlertedAt: notifiedAt },
      }),
      this.prisma.inboundUpdate.updateMany({
        where: { id: { in: inbound.map((row) => row.id) }, deliveryAlertedAt: null },
        data: { deliveryAlertedAt: notifiedAt },
      }),
    ]);
    log.info({ outbound: outbound.length, inbound: inbound.length }, 'delivery alert sent');
  }
}
