import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { MediaStorage } from '../media/media-storage.interface';

// Durable post-commit work; deliberately separate from business/outbox delivery.
export const FILE_DELETION_PREFIX = 'retention.file-delete.v1:';
type Deletion = { version: 1; storageKey: string; size: number; publicCode: string };

export async function queueFileDeletion(tx: Prisma.TransactionClient, file: Omit<Deletion, 'version'>): Promise<void> {
  const key = FILE_DELETION_PREFIX + createHash('sha256').update(file.storageKey).digest('hex');
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: JSON.stringify({ version: 1, ...file }) }, update: {} });
}

/** Called only after the incident transaction returned, or by a later retention run.
 * A lost COMMIT ACK leaves a durable intent; it never authorizes guessing ownership.
 */
export async function drainFileDeletions(db: PrismaClient, storage: MediaStorage) {
  const result = { deletedFiles: 0, deletedBytes: 0, failures: [] as Array<{ publicCode: string; error: string }> };
  const jobs = await db.systemSetting.findMany({ where: { key: { startsWith: FILE_DELETION_PREFIX } }, orderBy: { updatedAt: 'asc' }, take: 100 });
  for (const job of jobs) {
    let file: Deletion | undefined;
    try {
      file = JSON.parse(job.value) as Deletion;
      if (file.version !== 1 || typeof file.storageKey !== 'string' || !file.storageKey
        || typeof file.size !== 'number' || typeof file.publicCode !== 'string'
        || job.key !== FILE_DELETION_PREFIX + createHash('sha256').update(file.storageKey).digest('hex')) throw Error('INVALID_FILE_DELETION_RECORD');
      const candidate = file;
      const removed = await db.$transaction(async tx => {
        // Keep reference writers out while checking shared ownership and removing
        // an already committed orphan. No incident is deleted in this transaction.
        await tx.$executeRawUnsafe('SET LOCAL lock_timeout = \'2s\'');
        await tx.$executeRawUnsafe('LOCK TABLE "IncidentAttachment", "AnswerAttachment", "ClarificationAttachment", "OutboundMessage", "OperatorSession", "PrivateWorkItem", "InboundUpdate" IN SHARE ROW EXCLUSIVE MODE');
        const current = await tx.systemSetting.findUnique({ where: { key: job.key } });
        if (current?.value !== job.value) return false;
        const refs = await tx.$queryRaw<Array<{ present: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM "IncidentAttachment" WHERE "storageKey" = ${candidate.storageKey}
            UNION ALL SELECT 1 FROM "AnswerAttachment" WHERE "storageKey" = ${candidate.storageKey}
            UNION ALL SELECT 1 FROM "ClarificationAttachment" WHERE "storageKey" = ${candidate.storageKey}
            UNION ALL SELECT 1 FROM "OutboundMessage" WHERE jsonb_path_exists("attachments", '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', ${candidate.storageKey}::text))
              OR jsonb_path_exists("payload", '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', ${candidate.storageKey}::text))
            UNION ALL SELECT 1 FROM "OperatorSession" WHERE jsonb_path_exists("data", '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', ${candidate.storageKey}::text))
            UNION ALL SELECT 1 FROM "PrivateWorkItem" WHERE jsonb_path_exists("data", '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', ${candidate.storageKey}::text))
            UNION ALL SELECT 1 FROM "InboundUpdate" WHERE jsonb_path_exists("payload", '$.**.storageKey ? (@ == $key)', jsonb_build_object('key', ${candidate.storageKey}::text))
          ) AS present`;
        if (refs[0]?.present !== false) {
          // Rotate shared objects so they do not starve later unreferenced intents.
          await tx.systemSetting.updateMany({ where: { key: job.key, value: job.value }, data: { updatedAt: new Date() } });
          return false; // unknown is not absence
        }
        await storage.remove(candidate.storageKey); // idempotent; intent survives failure/rollback
        await tx.systemSetting.deleteMany({ where: { key: job.key, value: job.value } });
        return true;
      }, { maxWait: 5_000, timeout: 20_000 });
      if (removed) { result.deletedFiles += 1; result.deletedBytes += file.size; }
    } catch {
      result.failures.push({ publicCode: file?.publicCode ?? 'FILE_DELETION', error: 'FILE_DELETION_PENDING: задание сохранено для повторной проверки/удаления файла.' });
    }
  }
  return result;
}
