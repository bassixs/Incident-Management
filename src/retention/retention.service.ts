import { randomUUID } from 'node:crypto';

import { IncidentStatus, Prisma, type PrismaClient, UserRole } from '@prisma/client';

import type { MediaStorage } from '../media/media-storage.interface';
import { formatDateTime } from '../utils/datetime';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('retention');

export const INCIDENT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1_000;
const LOCK_KEY = 'maintenance.incident-retention';
const LOCK_TTL_MS = 2 * 60 * 60 * 1_000;
const TERMINAL_STATUSES = [IncidentStatus.RESOLVED, IncidentStatus.REJECTED] as const;

const RETENTION_SELECT = {
  id: true,
  publicCode: true,
  requesterId: true,
  answeredAt: true,
  attachments: { select: { storageKey: true, size: true } },
  answers: {
    select: {
      id: true,
      attachments: { select: { storageKey: true, size: true } },
    },
  },
} satisfies Prisma.IncidentSelect;

type RetentionCandidate = Prisma.IncidentGetPayload<{ select: typeof RETENTION_SELECT }>;

export type RetentionPreview = {
  retentionDays: number;
  cutoff: Date;
  incidents: number;
  files: number;
  bytes: number;
  outboundMessages: number;
  terminalWithoutCompletionDate: number;
  oldestCompletion: Date | null;
  sampleCodes: string[];
};

export type RetentionFailure = {
  publicCode: string;
  error: string;
};

export type RetentionRunResult = {
  preview: RetentionPreview;
  skippedBecauseLocked: boolean;
  deletedIncidents: number;
  deletedFiles: number;
  deletedBytes: number;
  deletedRequesterProfiles: number;
  failures: RetentionFailure[];
};

/**
 * Removes completed incidents after the published 90-day retention window.
 *
 * Physical objects are removed before the database row. A failed object
 * deletion leaves the incident in PostgreSQL so the next sweep can retry it.
 * Both local storage and S3 deletion are idempotent, therefore a crash after
 * deleting a file but before deleting the row is safe to retry.
 */
export class RetentionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: MediaStorage,
  ) {}

  cutoff(now = new Date()): Date {
    return new Date(now.getTime() - INCIDENT_RETENTION_DAYS * DAY_MS);
  }

  async preview(now = new Date()): Promise<RetentionPreview> {
    const cutoff = this.cutoff(now);
    const [candidates, terminalWithoutCompletionDate] = await Promise.all([
      this.loadCandidates(cutoff),
      this.prisma.incident.count({
        where: { status: { in: [...TERMINAL_STATUSES] }, answeredAt: null },
      }),
    ]);
    return this.buildPreview(candidates, cutoff, terminalWithoutCompletionDate);
  }

  async run(now = new Date()): Promise<RetentionRunResult> {
    const token = randomUUID();
    if (!(await this.acquireLock(token, now))) {
      const preview = await this.preview(now);
      return emptyRun(preview, true);
    }

    try {
      const cutoff = this.cutoff(now);
      const [candidates, terminalWithoutCompletionDate] = await Promise.all([
        this.loadCandidates(cutoff),
        this.prisma.incident.count({
          where: { status: { in: [...TERMINAL_STATUSES] }, answeredAt: null },
        }),
      ]);
      const preview = await this.buildPreview(candidates, cutoff, terminalWithoutCompletionDate);
      const result = emptyRun(preview, false);

      for (const incident of candidates) {
        const files = uniqueFiles(incident);
        try {
          for (const file of files) await this.storage.remove(file.storageKey);

          const answerIds = incident.answers.map((answer) => answer.id);
          const deleted = await this.prisma.$transaction(async (tx) => {
            await tx.outboundMessage.deleteMany({
              where: {
                OR: [
                  { incidentId: incident.id },
                  ...(answerIds.length ? [{ answerId: { in: answerIds } }] : []),
                ],
              },
            });
            await tx.actionLock.deleteMany({ where: { incidentId: incident.id } });
            return tx.incident.deleteMany({
              where: {
                id: incident.id,
                status: { in: [...TERMINAL_STATUSES] },
                answeredAt: { lte: cutoff },
              },
            });
          });

          if (deleted.count !== 1) {
            throw new Error('обращение перестало соответствовать условиям очистки');
          }
          result.deletedIncidents += 1;
          result.deletedFiles += files.length;
          result.deletedBytes += files.reduce((sum, file) => sum + file.size, 0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failures.push({ publicCode: incident.publicCode, error: message });
          log.error({ incidentId: incident.id, publicCode: incident.publicCode, err: message }, 'retention failed');
        }
      }

      result.deletedRequesterProfiles = await this.purgeOrphanRequesterProfiles(now);
      log.info(
        {
          deletedIncidents: result.deletedIncidents,
          deletedFiles: result.deletedFiles,
          deletedBytes: result.deletedBytes,
          deletedRequesterProfiles: result.deletedRequesterProfiles,
          failures: result.failures.length,
        },
        'retention sweep finished',
      );
      return result;
    } finally {
      await this.releaseLock(token).catch((error) =>
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'failed to release retention lock'),
      );
    }
  }

  private loadCandidates(cutoff: Date): Promise<RetentionCandidate[]> {
    return this.prisma.incident.findMany({
      where: {
        status: { in: [...TERMINAL_STATUSES] },
        answeredAt: { lte: cutoff },
      },
      orderBy: { answeredAt: 'asc' },
      select: RETENTION_SELECT,
    });
  }

  private async buildPreview(
    candidates: RetentionCandidate[],
    cutoff: Date,
    terminalWithoutCompletionDate: number,
  ): Promise<RetentionPreview> {
    const files = candidates.flatMap(uniqueFiles);
    const incidentIds = candidates.map((incident) => incident.id);
    const answerIds = candidates.flatMap((incident) => incident.answers.map((answer) => answer.id));
    const outboundMessages =
      incidentIds.length || answerIds.length
        ? await this.prisma.outboundMessage.count({
            where: {
              OR: [
                ...(incidentIds.length ? [{ incidentId: { in: incidentIds } }] : []),
                ...(answerIds.length ? [{ answerId: { in: answerIds } }] : []),
              ],
            },
          })
        : 0;

    return {
      retentionDays: INCIDENT_RETENTION_DAYS,
      cutoff,
      incidents: candidates.length,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      outboundMessages,
      terminalWithoutCompletionDate,
      oldestCompletion: candidates[0]?.answeredAt ?? null,
      sampleCodes: candidates.slice(0, 10).map((incident) => incident.publicCode),
    };
  }

  private async acquireLock(token: string, now: Date): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - LOCK_TTL_MS);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ key: string }>>(
      `INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
       VALUES ($1, $2, $3)
       ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value", "updatedAt" = EXCLUDED."updatedAt"
       WHERE "SystemSetting"."updatedAt" < $4
       RETURNING "key"`,
      LOCK_KEY,
      token,
      now,
      staleBefore,
    );
    return rows.length === 1;
  }

  private async releaseLock(token: string): Promise<void> {
    await this.prisma.systemSetting.deleteMany({ where: { key: LOCK_KEY, value: token } });
  }

  /** Remove requester identity only when no business or staff record uses it. */
  private async purgeOrphanRequesterProfiles(now: Date): Promise<number> {
    await this.prisma.operatorSession.deleteMany({ where: { expiresAt: { lte: now } } });
    const candidates = await this.prisma.user.findMany({
      where: {
        OR: [{ roles: { equals: [] } }, { roles: { equals: [UserRole.REQUESTER] } }],
        incidents: { none: {} },
        assignedByMe: { none: {} },
        respondingTo: { none: {} },
        approvedByMe: { none: {} },
        authoredAnswers: { none: {} },
        approvedAnswers: { none: {} },
        bansIssued: { none: {} },
      },
      select: { id: true, maxUserId: true },
      take: 1_000,
    });

    let deleted = 0;
    for (const user of candidates) {
      const sessions = await this.prisma.operatorSession.count({ where: { maxUserId: user.maxUserId } });
      if (sessions > 0) continue;
      const result = await this.prisma.user.deleteMany({ where: { id: user.id } });
      deleted += result.count;
    }
    return deleted;
  }
}

function uniqueFiles(incident: RetentionCandidate): Array<{ storageKey: string; size: number }> {
  const files = [
    ...incident.attachments,
    ...incident.answers.flatMap((answer) => answer.attachments),
  ];
  return [...new Map(files.map((file) => [file.storageKey, { storageKey: file.storageKey, size: file.size ?? 0 }])).values()];
}

function emptyRun(preview: RetentionPreview, skippedBecauseLocked: boolean): RetentionRunResult {
  return {
    preview,
    skippedBecauseLocked,
    deletedIncidents: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    deletedRequesterProfiles: 0,
    failures: [],
  };
}

export function formatRetentionPreview(preview: RetentionPreview): string {
  const lines = [
    `Хранение завершённых обращений: ${preview.retentionDays} дней.`,
    `Удалению подлежат завершённые до: ${formatDateTime(preview.cutoff)}.`,
    `Обращений: ${preview.incidents}.`,
    `Файлов заявителей и ответов: ${preview.files} (${formatBytes(preview.bytes)}).`,
    `Связанных служебных сообщений: ${preview.outboundMessages}.`,
  ];
  if (preview.oldestCompletion) lines.push(`Самое старое завершение: ${formatDateTime(preview.oldestCompletion)}.`);
  if (preview.sampleCodes.length) lines.push(`Примеры: ${preview.sampleCodes.join(', ')}.`);
  if (preview.terminalWithoutCompletionDate > 0) {
    lines.push(
      `Внимание: завершённых обращений без даты завершения — ${preview.terminalWithoutCompletionDate}; они не удаляются автоматически.`,
    );
  }
  return lines.join('\n');
}

export function formatRetentionRun(result: RetentionRunResult): string {
  if (result.skippedBecauseLocked) return 'Очистка уже выполняется другим процессом. Повторный запуск пропущен.';
  const lines = [
    'Очистка завершённых обращений завершена.',
    `Удалено обращений: ${result.deletedIncidents}.`,
    `Удалено файлов: ${result.deletedFiles} (${formatBytes(result.deletedBytes)}).`,
    `Удалено неиспользуемых профилей заявителей: ${result.deletedRequesterProfiles}.`,
    `Ошибок: ${result.failures.length}.`,
  ];
  if (result.failures.length) {
    lines.push('', 'Не удалось удалить:');
    for (const failure of result.failures.slice(0, 10)) lines.push(`${failure.publicCode}: ${failure.error}`);
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} Б`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} КБ`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} МБ`;
  return `${(bytes / 1_073_741_824).toFixed(1)} ГБ`;
}
