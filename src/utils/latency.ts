import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MaxError } from '@maxhub/max-bot-api';
import { moduleLogger } from './logger';

/** Only internal identifiers and clocks; never callback payloads or MAX content. */
export type DeliveryTrace = { inboxId?: string; receivedAt?: number; outboxId?: string };
const context = new AsyncLocalStorage<DeliveryTrace>();
const log = moduleLogger('latency');
export function deliveryTrace(): DeliveryTrace { return { ...context.getStore() }; }
export function withDeliveryTrace<T>(trace: DeliveryTrace, work: () => T): T {
  // Persisted payloads can predate this version. Copy only validated technical fields.
  const safe: DeliveryTrace = {};
  for (const key of ['inboxId', 'outboxId'] as const) {
    if (typeof trace[key] === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(trace[key]!)) safe[key] = trace[key];
  }
  if (typeof trace.receivedAt === 'number' && Number.isFinite(trace.receivedAt)) safe.receivedAt = trace.receivedAt;
  return context.run(safe, work);
}
export function latency(event: 'inbox-start' | 'callback-ack' | 'screen-created' | 'outbox-start' | 'outbox-sent' | 'max-request',
  fields: { durationMs?: number; waitMs?: number; rateWaitMs?: number; requestMs?: number; ageMs?: number;
    method?: string; requestId?: string; attempt?: number; status?: number; ok?: boolean; outboxId?: string } = {}): void {
  log.info({ ...deliveryTrace(), event, ...fields }, 'latency measurement');
}

/** Observe existing direct membership calls without changing their retry/rate policy. */
export async function observeMembership<T>(operation: () => Promise<T>): Promise<T> {
  const started = Date.now(), requestId = randomUUID();
  try {
    const result = await operation();
    latency('max-request', { method: 'getChatMembers', requestId, requestMs: Date.now() - started, rateWaitMs: 0, attempt: 1, ok: true });
    return result;
  } catch (error) {
    latency('max-request', { method: 'getChatMembers', requestId, requestMs: Date.now() - started, rateWaitMs: 0, attempt: 1, ok: false,
      ...(error instanceof MaxError ? { status: error.status } : {}) });
    throw error;
  }
}
