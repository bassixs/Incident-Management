import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getConfig } from '../../src/config';
import { BotStatusService, inspectBotHealth } from '../../src/monitoring/bot-status.service';
import { MaxMessageService } from '../../src/max/max-message.service';
import { SUBSCRIBED_UPDATE_TYPES } from '../../src/max/max-types';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

describeIntegration('durable weekly bot reports', () => {
  let prisma: PrismaClient;
  let originalRecipients: bigint[];
  let now: Date;
  const max = { getMe: vi.fn(), listWebhookSubscriptions: vi.fn() };
  const config = () => ({ ...getConfig(), BOT_MODE: 'webhook' as const, WEBHOOK_URL: 'https://test.invalid/webhook' });
  const service = (inspect = vi.fn(async (_now: Date): Promise<string[]> => [])) =>
    new BotStatusService(prisma, max as never, config(), () => now, inspect);
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase(prisma);
    originalRecipients = getConfig().BOT_STATUS_USER_IDS;
    getConfig().BOT_STATUS_USER_IDS = [555n, 556n];
    now = new Date('2026-10-05T05:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    max.getMe.mockResolvedValue({ user_id: 777 });
    max.listWebhookSubscriptions.mockResolvedValue([{ url: config().WEBHOOK_URL, update_types: [...SUBSCRIBED_UPDATE_TYPES] }]);
  });
  afterEach(() => { getConfig().BOT_STATUS_USER_IDS = originalRecipients; vi.useRealTimers(); vi.restoreAllMocks(); });

  it('plans one job per recipient atomically under concurrent instances and restart', async () => {
    await Promise.all([service().checkNow(), service().checkNow(), service().checkNow()]);
    await service().checkNow();
    const jobs = await prisma.outboundMessage.findMany({ orderBy: { targetId: 'asc' } });
    expect(jobs.map(j => j.targetId)).toEqual([555n, 556n]);
    expect(jobs.map(j => j.dedupeKey)).toEqual(['bot-status:2026-41:555', 'bot-status:2026-41:556']);
    expect(await prisma.systemSetting.count()).toBe(1);
    expect(jobs[0]!.payload).toMatchObject({ text: 'Доброе утро! Чат-бот «На связи_регион40» работает. По автоматической проверке на 08:00 МСК проблем не обнаружено.' });
  });

  it('rolls back the run marker when recipient jobs cannot be saved, then recovers', async () => {
    const badConfig = { ...config(), BOT_STATUS_USER_IDS: [555n, 9223372036854775808n] };
    await expect(new BotStatusService(prisma, max as never, badConfig, () => now, async () => []).checkNow()).rejects.toThrow();
    expect(await prisma.systemSetting.count()).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(0);
    await service().checkNow();
    expect(await prisma.outboundMessage.count()).toBe(2);
  });

  it('catches up on start only on the scheduled Moscow day, never replays old weeks', async () => {
    now = new Date('2026-10-06T05:00:00Z');
    await service().checkNow();
    expect(await prisma.outboundMessage.count()).toBe(0);
    now = new Date('2026-10-12T10:17:00Z');
    const s = service(); s.start(); await s.waitForIdle(); s.stop();
    const jobs = await prisma.outboundMessage.findMany();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.dedupeKey?.startsWith('bot-status:2026-42:'))).toBe(true);
    expect((jobs[0]!.payload as { text: string }).text).toContain('13:17 МСК');
  });

  it('allows the following week after a completed week', async () => {
    await service().checkNow(); now = new Date('2026-10-12T05:00:00Z');
    await service().checkNow(); expect(await prisma.outboundMessage.count()).toBe(4);
  });

  it('does nothing, including no DB or health checks, when disabled', async () => {
    getConfig().BOT_STATUS_USER_IDS = [];
    const read = vi.spyOn(prisma.systemSetting, 'findUnique'); const inspect = vi.fn(async () => []);
    const s = service(inspect); s.start(); await s.checkNow(); s.stop();
    expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  });

  it('does not persist a check which finishes after the Moscow day ends', async () => {
    await service(vi.fn(async () => { now = new Date('2026-10-05T21:00:00Z'); return []; })).checkNow();
    expect(await prisma.outboundMessage.count()).toBe(0);
  });

  it('keeps recipient failures independent and retries with the original check time', async () => {
    await service().checkNow();
    const sendToUser = vi.fn(async (id: bigint) => {
      if (id === 555n) throw new Error('sensitive-raw-error');
      return { body: { mid: `report-${id}` } };
    });
    const worker = new MaxMessageService({ sendToUser } as never, { prisma, storage: {} as never });
    await worker.flush();
    const jobs = await prisma.outboundMessage.findMany({ orderBy: { targetId: 'asc' } });
    expect(jobs.map(j => j.status)).toEqual(['PENDING', 'SENT']);
    expect(jobs[0]!.lastError).toBe('Не удалось доставить плановый отчёт MAX.');
    sendToUser.mockImplementation(async id => ({ body: { mid: `retried-${id}` } }));
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
    const restarted = new MaxMessageService({ sendToUser } as never, { prisma, storage: {} as never });
    await restarted.flush(); await service().checkNow(); await restarted.flush();
    expect(await prisma.outboundMessage.count({ where: { status: 'SENT' } })).toBe(2);
    expect(sendToUser).toHaveBeenCalledTimes(3);
    const last = sendToUser.mock.calls.at(-1) as unknown as [bigint, string];
    expect(last[0]).toBe(555n);
    expect(last[1]).toContain('Отложенный отчёт. Результат проверки от 05.10.2026 08:00 МСК.');
  });

  it.each(['expired', 'disabled'] as const)('retires %s pending reports without contacting MAX', async why => {
    await service().checkNow();
    if (why === 'expired') vi.setSystemTime(new Date('2026-10-05T21:00:00Z'));
    else getConfig().BOT_STATUS_USER_IDS = [];
    const sendToUser = vi.fn();
    await new MaxMessageService({ sendToUser } as never, { prisma, storage: {} as never }).flush();
    expect(sendToUser).not.toHaveBeenCalled();
    const jobs = await prisma.outboundMessage.findMany();
    expect(jobs.every(j => j.status === 'SENT' && j.sentAt === null && j.firstMessageId === null)).toBe(true);
    expect(jobs.every(j => j.lastError?.startsWith('Плановый отчёт пропущен'))).toBe(true);
  });

  it('does not classify fresh PENDING as unhealthy, but detects retry, failed and stuck jobs', async () => {
    await prisma.inboundUpdate.create({ data: { externalUpdateKey: 'fresh', updateType: 'message_created', payload: {}, receivedAt: now, nextAttemptAt: now } });
    await prisma.outboundMessage.create({ data: { targetType: 'user', targetId: 555n, payload: {}, attachments: [], createdAt: now, nextAttemptAt: now } });
    expect(await inspectBotHealth(prisma, max as never, config(), now)).toEqual([]);
    await prisma.inboundUpdate.updateMany({ data: { status: 'PROCESSING', lockedAt: new Date(now.getTime() - 120_001) } });
    await prisma.outboundMessage.updateMany({ data: { attempts: 1 } });
    const problems = await inspectBotHealth(prisma, max as never, config(), now);
    expect(problems).toContain('Зависшая обработка: входящих 1, исходящих 0.');
    expect(problems).toContain('Задания с повторными попытками: входящих 0, исходящих 1.');
    await prisma.outboundMessage.updateMany({ data: { status: 'FAILED' } });
    expect(await inspectBotHealth(prisma, max as never, config(), now)).toContain('Ошибки очередей: входящих 0, исходящих 1.');
  });

  it('persists an unavailable-check report without leaking the exception', async () => {
    await service(vi.fn(async () => { throw new Error('raw secret 79991234567'); })).checkNow();
    const job = await prisma.outboundMessage.findFirstOrThrow();
    expect((job.payload as { text: string }).text).toContain('Автоматическая проверка не завершена.');
    expect(JSON.stringify(job.payload)).not.toMatch(/raw|secret|79991234567|проблем не обнаружено/);
  });
});
