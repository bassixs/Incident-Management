import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { MediaStorage } from '../media/media-storage.interface';

export const FILE_DELETION_PREFIX = 'retention.file-delete.v1:';
export const FILE_DELETION_STATE_PREFIX = 'retention.file-state.v1:';
export const FILE_DELETION_FENCE_PREFIX = 'retention.file-fence.v1:';
const MAX_ATTEMPTS = 3;
const RETRY_MS = 60_000;
type Deletion = { version: 1; storageKey: string; size: number; publicCode: string };
type State = { version: 1; attempts: number; status: 'pending' | 'exhausted' | 'unknown' | 'invalid'; nextAttemptAt: number; reason: string };
const digest = (key: string) => createHash('sha256').update(key).digest('hex');

export async function queueFileDeletion(tx: Prisma.TransactionClient, file: Omit<Deletion, 'version'>): Promise<void> {
  const key = FILE_DELETION_PREFIX + digest(file.storageKey);
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: JSON.stringify({ version: 1, ...file }) }, update: {} });
}

/** An external timeout never cancels storage I/O. A committed, permanent per-key
 * fence keeps late completion safe; it must survive success, restart and rollback.
 * Database triggers serialize reference creation with this fence (migration required).
 */
export async function drainFileDeletions(db: PrismaClient, storage: MediaStorage, options: { now?: () => number; removeTimeoutMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.removeTimeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) throw Error('INVALID_STORAGE_TIMEOUT');
  const result = { deletedFiles: 0, deletedBytes: 0, failures: [] as Array<{ publicCode: string; error: string }> };
  const guards = await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND t.tgname='guard_retired_storage' AND t.tgenabled='O'
      AND c.relname IN ('IncidentAttachment','AnswerAttachment','ClarificationAttachment','OutboundMessage','OperatorSession','PrivateWorkItem','InboundUpdate')`;
  if (Number(guards[0]?.count) !== 7) throw Error('STORAGE_REFERENCE_GUARDS_NOT_INSTALLED');
  const jobs = await db.systemSetting.findMany({ where: { key: { startsWith: FILE_DELETION_PREFIX } }, orderBy: [{ updatedAt: 'asc' }, { key: 'asc' }], take: 100 });
  for (const job of jobs) {
    const stateKey = FILE_DELETION_STATE_PREFIX + job.key.slice(FILE_DELETION_PREFIX.length);
    let file: Deletion | undefined;
    let invalidSavedState = false;
    let state: State = { version: 1, attempts: 0, status: 'pending', nextAttemptAt: 0, reason: '' };
    const saveState = async () => db.systemSetting.upsert({ where: { key: stateKey },
      create: { key: stateKey, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
    try {
      // Rotate every examined record, including malformed/exhausted records. No
      // failing prefix of 100 records can starve subsequent intents across runs.
      await db.systemSetting.updateMany({ where: { key: job.key, value: job.value }, data: { updatedAt: new Date(now()) } });
      const saved = await db.systemSetting.findUnique({ where: { key: stateKey } });
      if (saved) {
        invalidSavedState = true;
        state = JSON.parse(saved.value) as State;
        if (state.version !== 1 || !Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > MAX_ATTEMPTS
          || !['pending','exhausted','unknown','invalid'].includes(state.status) || !Number.isFinite(state.nextAttemptAt)) throw Error('INVALID_FILE_STATE');
        invalidSavedState = false;
      }
      if (state.status !== 'pending' || state.nextAttemptAt > now()) continue;
      file = JSON.parse(job.value) as Deletion;
      if (file.version !== 1 || typeof file.storageKey !== 'string' || !file.storageKey
        || !Number.isFinite(file.size) || file.size < 0 || typeof file.publicCode !== 'string'
        || job.key !== FILE_DELETION_PREFIX + digest(file.storageKey)) throw Error('INVALID_FILE_DELETION_RECORD');
      const candidate = file;
      // Persist the budget before attempting work: process failure cannot reset it.
      state = { ...state, attempts: state.attempts + 1, nextAttemptAt: now() + RETRY_MS, reason: 'ATTEMPT_STARTED' };
      if (state.attempts > MAX_ATTEMPTS) { state.attempts = MAX_ATTEMPTS; state.status = 'exhausted'; await saveState(); continue; }
      await saveState();
      const fenced = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.storageKey}, 724091))`;
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
        if (refs[0]?.present !== false) return false;
        const fenceKey = FILE_DELETION_FENCE_PREFIX + digest(candidate.storageKey);
        await tx.systemSetting.upsert({ where: { key: fenceKey },
          create: { key: fenceKey, value: 'PERMANENT_STORAGE_KEY_RETIREMENT_V1' }, update: {} });
        return true;
      }, { maxWait: 5_000, timeout: 5_000, isolationLevel: 'ReadCommitted' });
      if (!fenced) {
        state.reason = 'REFERENCED_OR_CHANGED';
        if (state.attempts >= MAX_ATTEMPTS) state.status = 'exhausted';
        await saveState(); continue;
      }
      // No database transaction or lock is held during external I/O.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          storage.remove(candidate.storageKey),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('STORAGE_RESULT_UNKNOWN')), timeoutMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      await db.$transaction(async tx => {
        await tx.systemSetting.deleteMany({ where: { key: job.key, value: job.value } });
        await tx.systemSetting.deleteMany({ where: { key: stateKey } });
      });
      result.deletedFiles += 1; result.deletedBytes += file.size;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      const invalid = !file || reason.startsWith('INVALID_');
      state = { version: 1, attempts: Math.min(MAX_ATTEMPTS, Number.isInteger(state?.attempts) ? state.attempts : 0),
        status: invalid ? 'invalid' : reason === 'STORAGE_RESULT_UNKNOWN' ? 'unknown' : state.attempts >= MAX_ATTEMPTS ? 'exhausted' : 'pending',
        nextAttemptAt: now() + RETRY_MS,
        reason: invalid ? 'INVALID_RECORD_REQUIRES_REVIEW' : reason === 'STORAGE_RESULT_UNKNOWN' ? 'STORAGE_RESULT_UNKNOWN' : 'FILE_DELETION_FAILED' };
      // If persistence is unavailable, abort the sweep rather than spin or infer success.
      if (!invalidSavedState) await saveState(); // preserve damaged metadata verbatim for review
      result.failures.push({ publicCode: file?.publicCode ?? 'FILE_DELETION', error: `FILE_DELETION_PENDING: ${state.reason}; ${state.status}; запись сохранена.` });
    }
  }
  return result;
}
