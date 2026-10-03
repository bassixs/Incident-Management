import type { AppServices } from '../app/container';
import { botAddedGreeting } from '../bot/views/bot-added';
import { workingChatFor } from '../users/working-chat';

export const RETIRED_GREETING_REASON = 'MANUALLY_RETIRED_FOREIGN_BOT_ADDED: Не доставлено. Ненужное приветствие постороннему чату снято с автоматических повторов по решению администратора.';
type Services = Pick<AppServices, 'prisma' | 'config'>;
export type GreetingRetirementPreview = {
  jobs: Array<{ id: string; targetId: string; targetType: 'chat'; inboxId: string; status: string; attempts: number; fingerprint: string }>;
  sql: string;
};

/** Read-only. Produces a guarded transaction for separate operator review;
 * never applies it, dispatches MAX requests or starts an application worker. */
export async function previewGreetingRetirement(services: Services, ids: string[]): Promise<GreetingRetirementPreview> {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) {
    throw new Error('Expected 1–20 distinct full lowercase outbox UUIDs');
  }
  return services.prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const jobs: GreetingRetirementPreview['jobs'] = [];
    for (const id of ids) {
      const row = await tx.outboundMessage.findUniqueOrThrow({ where: { id } });
      const payload = row.payload as { text?: unknown; trace?: { inboxId?: string }; operation?: unknown };
      const inboxId = payload.trace?.inboxId;
      const origin = typeof inboxId === 'string' ? await tx.inboundUpdate.findUnique({ where: { id: inboxId } }) : null;
      const attachments = row.attachments;
      if (!['PENDING','FAILED'].includes(row.status) || row.lockedAt || row.targetType !== 'chat' ||
        row.incidentId || row.answerId || row.trackingType || row.dedupeKey || row.sentAt || row.firstMessageId ||
        !Array.isArray(attachments) || attachments.length || row.attempts < 1 ||
        row.lastError !== '403: Insufficient access rights to perform this action' ||
        payload.text !== botAddedGreeting(row.targetId) || Object.keys(payload).some(k => !['text','trace'].includes(k)) ||
        !origin || origin.updateType !== 'bot_added' || origin.status !== 'PROCESSED') {
        throw new Error(`Refused: ${id} is not an untouched, undelivered bot_added greeting with the expected MAX 403`);
      }
      if (await workingChatFor({ ...services, prisma: tx } as AppServices, row.targetId)) {
        throw new Error(`Refused: ${id} targets a configured work chat`);
      }
      const hash = await tx.$queryRaw<Array<{ fingerprint: string }>>`SELECT md5(to_jsonb(o)::text) fingerprint FROM "OutboundMessage" o WHERE id=${id}`;
      jobs.push({ id, targetId: row.targetId.toString(), targetType: 'chat', inboxId: inboxId!, status: row.status, attempts: row.attempts, fingerprint: hash[0]!.fingerprint });
    }
    const rows = jobs.map(x => `('${x.id}', '${x.fingerprint}', ${x.targetId})`).join(',\n');
    const configured = [services.config.DISTRIBUTION_CHAT_ID, services.config.REVIEW_CHAT_ID, services.config.DELIVERY_ALERT_CHAT_ID]
      .filter((x): x is bigint => x !== undefined).map(String);
    const sql = `-- Generated preview only. Back up, stop/drain app, re-preview and review before applying.
-- Uses FAILED, never SENT; records and payloads remain. Existing manual retry can requeue FAILED.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
CREATE TEMP TABLE greeting_scope(id text PRIMARY KEY, fingerprint text, target bigint) ON COMMIT DROP;
INSERT INTO greeting_scope VALUES ${rows};
DO $guard$
DECLARE matched integer; changed integer;
BEGIN
  PERFORM 1 FROM "OutboundMessage" o JOIN greeting_scope s ON s.id=o.id FOR UPDATE OF o NOWAIT;
  SELECT count(*) INTO matched FROM "OutboundMessage" o JOIN greeting_scope s ON s.id=o.id
    WHERE md5(to_jsonb(o)::text)=s.fingerprint AND o."targetId"=s.target
      AND o.status IN ('PENDING','FAILED') AND o."lockedAt" IS NULL
      AND NOT EXISTS(SELECT 1 FROM "ResponsibleGroup" g WHERE g."isActive" AND g."maxChatId"=s.target)
      ${configured.length ? `AND s.target NOT IN (${configured.join(',')})` : ''};
  IF matched <> ${jobs.length} THEN RAISE EXCEPTION 'Greeting scope changed; rollback and generate a fresh preview'; END IF;
  UPDATE "OutboundMessage" o SET status='FAILED', "lockedAt"=NULL,
    "lastError"='${RETIRED_GREETING_REASON}', "updatedAt"=timezone('UTC',now())
    FROM greeting_scope s WHERE o.id=s.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> ${jobs.length} THEN RAISE EXCEPTION 'Unexpected affected row count'; END IF;
END $guard$;
SELECT o.id,o.status,o.attempts,o."targetType",o."targetId",o."sentAt",o."firstMessageId",o."lastError"
  FROM "OutboundMessage" o JOIN greeting_scope s ON s.id=o.id ORDER BY o.sequence;
COMMIT;
`;
    return { jobs, sql };
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
}
