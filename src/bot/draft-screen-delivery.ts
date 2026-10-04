import { createHash } from 'node:crypto';
import { MaxError } from '@maxhub/max-bot-api';
import type { OperatorSession, SessionType } from '@prisma/client';
import type { AppServices } from '../app/container';
import type { CompositeMessage } from '../max/max-message.service';
import { isResidentDraft, RESIDENT_DRAFT_TYPES, type SessionData } from '../sessions/operator-session.service';
import { ValidationError } from '../utils/errors';
import { deliveryTrace } from '../utils/latency';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('draft-screen');
const RETRY_DELAYS = [5_000, 30_000, 120_000];
const LEASE_MS = 300_000;
export const OLD_SCREEN_NOTICE = 'Это действие устарело: открыта старая страница. Используйте последнее сообщение бота или нажмите «Создать сообщение» → «Продолжить черновик».';
export const SCREEN_PENDING_NOTICE = 'Не удалось показать следующий экран. Черновик сохранён, сообщение не отправлено. Бот повторит показ. Также можно открыть меню → «Создать сообщение» → «Продолжить черновик».';
type SavedScreen = Pick<CompositeMessage, 'text' | 'keyboard'> & {
  attachments?: Array<{ type: 'IMAGE'; maxToken: string }>;
};
export type DraftScreenDelivery = {
  screenToken: string;
  message: SavedScreen;
  preview: boolean;
  attempts: number;
  status: 'pending' | 'sending' | 'exhausted';
  nextAttemptAt: number;
  inboxId?: string;
};
class SupersededScreen extends ValidationError {}
export class DraftScreenPendingError extends ValidationError {
  constructor() { super(SCREEN_PENDING_NOTICE); }
}
export function screenRef(value?: string): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
}
export function screenFacts(data: SessionData) {
  return { draft: screenRef(data.draftToken), screen: screenRef(data.screenToken), stage: data.screenStage ?? data.draftStage,
    field: data.draftEditField, page: data.screenPage };
}

/** Stored only in the owner-scoped expiring session, never in the general outbox.
 * No business callback is replayed. Only server-rendered text/token photos/buttons.
 */
export function prepareScreenDelivery(data: SessionData, message: CompositeMessage, preview = false, stage?: SessionType): void {
  if (!data.screenToken || !data.draftToken) throw new Error('Unbound draft screen');
  const photos = message.attachments?.map(item => {
    if (item.type !== 'IMAGE' || !item.maxToken) throw new Error('Draft recovery requires token photos');
    return { type: 'IMAGE' as const, maxToken: item.maxToken };
  });
  // Draft screens are short and fit into one MAX message, including all photos.
  if (Array.from(message.text).length > 3800 || (photos?.length ?? 0) > 4) throw new Error('Draft screen exceeds one message');
  data.screenStage = stage;
  data.draftScreenDelivery = {
    screenToken: data.screenToken, message: { text: message.text, ...(message.keyboard ? { keyboard: message.keyboard } : {}),
      ...(photos?.length ? { attachments: photos } : {}) },
    preview, attempts: 0, status: 'pending', nextAttemptAt: Date.now(), ...deliveryTraceInbox(),
  };
}
function deliveryTraceInbox() { const { inboxId } = deliveryTrace(); return inboxId ? { inboxId } : {}; }

async function matches(services: AppServices, expected: OperatorSession): Promise<OperatorSession | null> {
  const current = await services.sessions.find(expected.maxUserId, expected.chatId);
  if (!current || current.id !== expected.id || current.type !== expected.type || !isResidentDraft(current.type)) return null;
  const wanted = services.sessions.readData(expected), actual = services.sessions.readData(current);
  if (wanted.draftScreenDelivery?.status === 'sending' && (
    actual.draftScreenDelivery?.status !== 'sending' ||
    actual.draftScreenDelivery.attempts !== wanted.draftScreenDelivery.attempts ||
    actual.draftScreenDelivery.nextAttemptAt !== wanted.draftScreenDelivery.nextAttemptAt
  )) return null;
  return wanted.draftToken === actual.draftToken && wanted.screenToken === actual.screenToken &&
    actual.draftScreenDelivery?.screenToken === wanted.screenToken ? current : null;
}

/** Preserve media; only known IDs returned by our draft sends are accepted here. */
async function retire(services: AppServices, id: string): Promise<boolean> {
  try { if (await services.messages.retireDraftScreen(id, OLD_SCREEN_NOTICE)) return true; } catch { /* best effort */ }
  log.info({ messageId: id, result: 'retire-deferred' }, 'draft screen delivery');
  return false;
}

export async function retirePreviousScreens(services: AppServices, session: OperatorSession): Promise<void> {
  const current = await services.sessions.find(session.maxUserId, session.chatId);
  if (!current || current.id !== session.id) return;
  const data = services.sessions.readData(current);
  if (data.draftToken !== services.sessions.readData(session).draftToken) return;
  const ids = (data.screenRetireIds ?? []).filter(id => id !== data.screenMessageId).slice(0, 5);
  if (!ids.length || (data.screenRetireAttempts ?? 0) >= 4 || (data.screenRetireAt ?? 0) > Date.now()) return;
  const removed: string[] = [];
  for (const id of ids) if (await retire(services, id)) removed.push(id);
  const attempts = (data.screenRetireAttempts ?? 0) + 1;
  await services.sessions.replaceCurrent(current, current.type,
    { ...data, screenRetireIds: (data.screenRetireIds ?? []).filter(id => !removed.includes(id)), screenRetireAttempts: attempts,
      screenRetireAt: Date.now() + (RETRY_DELAYS[attempts - 1] ?? LEASE_MS) });
  if (removed.length !== ids.length) log.info({ ...screenFacts(data), result: 'retire-deferred', remaining: ids.length - removed.length, attempt: attempts }, 'draft screen delivery');
}

/** Caller owns resident-draft lock. CAS and send guards also cover expiry,
 * cancellation outside that lock, process death and a late MAX response.
 */
export async function deliverSavedScreen(services: AppServices, expected: OperatorSession): Promise<void> {
  const saved = services.sessions.readData(expected);
  if (!saved.draftToken || saved.draftScreenDelivery?.screenToken !== saved.screenToken) {
    // Old/rolled-back code may retain a job after changing the screen. Consume
    // only this exact stale snapshot so it cannot occupy every sweep forever.
    const cleaned = { ...saved }; delete cleaned.draftScreenDelivery;
    await services.sessions.replaceCurrent(expected, expected.type, cleaned);
    return;
  }
  const current = await matches(services, expected);
  if (!current) return;
  const data = services.sessions.readData(current), job = data.draftScreenDelivery!;
  if (job.status === 'exhausted' || job.nextAttemptAt > Date.now()) return;
  if (job.attempts >= 4) {
    await services.sessions.replaceCurrent(current, current.type, { ...data, draftScreenDelivery: { ...job, status: 'exhausted' } });
    return;
  }
  const claimed: SessionData = { ...data, draftScreenDelivery: { ...job, status: 'sending', attempts: job.attempts + 1, nextAttemptAt: Date.now() + LEASE_MS } };
  if (!await services.sessions.replaceCurrent(current, current.type, claimed)) return;
  const snapshot = { ...current, data: claimed as never };
  const check = async () => { if (!await matches(services, snapshot)) throw new SupersededScreen('Draft screen superseded'); };
  log.info({ ...screenFacts(data), inboxId: job.inboxId, attempt: job.attempts + 1, result: 'sending' }, 'draft screen delivery');
  let messageId: string | undefined;
  try {
    await check();
    const sent = await services.messages.send({ userId: current.maxUserId }, {
      ...job.message, immediatePreview: true, beforeImmediateSend: check,
    });
    messageId = sent.firstMessageId;
    if (sent.state !== 'sent' || !messageId) throw new Error('Draft screen delivery unconfirmed');
    const live = await matches(services, snapshot);
    if (!live) { await retire(services, messageId); return; }
    const next = { ...services.sessions.readData(live) };
    delete next.draftScreenDelivery;
    next.screenMessageId = messageId;
    next.screenRetireAttempts = 0; next.screenRetireAt = 0;
    next.screenRetireIds = [...new Set([...(next.screenRetireIds ?? []), data.screenMessageId, data.previewMessageId].filter((id): id is string => !!id && id !== messageId))];
    if (job.preview) { next.previewMessageId = messageId; delete next.previewDeliveryPending; }
    else delete next.previewMessageId;
    if (!await services.sessions.replaceCurrent(live, live.type, next)) { await retire(services, messageId); return; }
    log.info({ ...screenFacts(next), inboxId: job.inboxId, messageId, result: 'sent' }, 'draft screen delivery');
    await retirePreviousScreens(services, { ...live, data: next as never });
  } catch (error) {
    if (error instanceof SupersededScreen) return;
    // Never log error text or the saved message: both may contain private data.
    const live = await matches(services, snapshot);
    if (!live) { if (messageId) await retire(services, messageId); return; }
    const nowData = services.sessions.readData(live), attempt = job.attempts + 1;
    const retryable = !(error instanceof ValidationError) && (!(error instanceof MaxError) || [408, 425, 429, 500, 502, 503, 504].includes(error.status));
    const exhausted = !retryable || attempt >= 4;
    await services.sessions.replaceCurrent(live, live.type, { ...nowData, draftScreenDelivery: {
      ...job, attempts: attempt, status: exhausted ? 'exhausted' : 'pending', nextAttemptAt: Date.now() + (RETRY_DELAYS[attempt - 1] ?? LEASE_MS),
    } });
    log.warn({ ...screenFacts(data), inboxId: job.inboxId, attempt, status: error instanceof MaxError ? error.status : undefined,
      result: exhausted ? 'exhausted' : 'retry-scheduled' }, 'draft screen delivery');
    if (!retryable) throw error;
    throw new DraftScreenPendingError();
  }
}

/** Bounded, restart-safe sweep; independent of FIFO work notifications. */
export class DraftScreenRecovery {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly services: AppServices) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick().catch(() => log.error({ result: 'sweep-failed' }, 'draft screen recovery')), 5_000);
    this.timer.unref?.();
    void this.tick().catch(() => log.error({ result: 'startup-failed' }, 'draft screen recovery'));
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async waitForIdle(): Promise<void> { await this.running; }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async sweep(): Promise<void> {
    const services = this.services;
    const rows = await services.prisma.operatorSession.findMany({ where: { type: { in: RESIDENT_DRAFT_TYPES }, expiresAt: { gt: new Date() }, AND: [
      { data: { path: ['draftScreenDelivery', 'nextAttemptAt'], lte: Date.now() } },
      { data: { path: ['draftScreenDelivery', 'attempts'], lte: 4 } },
      { data: { path: ['draftScreenDelivery', 'status'], not: 'exhausted' } },
    ] }, orderBy: { createdAt: 'asc' }, take: 20 });
    const cleanup = await services.prisma.operatorSession.findMany({ where: { type: { in: RESIDENT_DRAFT_TYPES }, expiresAt: { gt: new Date() }, AND: [
      { data: { path: ['screenRetireIds'], not: [] } },
      { data: { path: ['screenRetireAt'], lte: Date.now() } }, { data: { path: ['screenRetireAttempts'], lt: 4 } },
    ] }, take: 10 });
    for (const row of cleanup) {
      if (this.stopped) return;
      if (!isResidentDraft(row.type)) continue;
      const key = `resident-draft:${row.maxUserId}:${row.chatId}`;
      if (!await services.actionGuard.acquire({ key, action: 'resident-draft', maxUserId: row.maxUserId, ttlMs: LEASE_MS })) continue;
      try { await retirePreviousScreens(services, row); } finally { await services.actionGuard.release(key); }
    }
    // Two bounded independent lanes: one slow recipient cannot hold all recovery.
    for (let offset = 0; offset < rows.length && !this.stopped; offset += 2) await Promise.all(rows.slice(offset, offset + 2).map(async row => {
      if (!isResidentDraft(row.type)) return;
      const key = `resident-draft:${row.maxUserId}:${row.chatId}`;
      if (!await services.actionGuard.acquire({ key, action: 'resident-draft', maxUserId: row.maxUserId, ttlMs: LEASE_MS })) return;
      try { await deliverSavedScreen(services, row); }
      catch (error) { if (!(error instanceof DraftScreenPendingError)) log.warn({ ...screenFacts(services.sessions.readData(row)), result: 'recovery-refused' }, 'draft screen recovery'); }
      finally { await services.actionGuard.release(key); }
    }));
  }
}
