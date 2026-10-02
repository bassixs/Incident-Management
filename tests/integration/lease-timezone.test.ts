import { type PrismaClient, UserRole } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { actorFor, createHarness, createTestPrisma, describeIntegration, GROUP_CODES,
  pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { getConfig, resetConfigCache } from '../../src/config';
import { distributionCard, incidentLookupCard, reviewCard, sectorCard } from '../../src/bot/views/cards';
import { leaseView, SECTOR_LEASE_ACTION } from '../../src/work-queues/leases';
import { REVIEW_LEASE_ACTION, workPanelText } from '../../src/work-queues/state';
import { queueSnapshot } from '../../src/distribution/queue-state';
import { enterPersonalWork, invitePersonalWork, sweepPersonalWork } from '../../src/work-queues/private-workspace';

const cases = (['distribution', 'sector', 'review'] as const).flatMap(kind => [
  { kind, takeAt: '2026-09-30T13:41:00.000Z', until: '2026-09-30T13:56:00.000Z', label: '30.09.2026 16:56' },
  { kind, takeAt: '2026-09-30T20:51:00.000Z', until: '2026-09-30T21:06:00.000Z', label: '01.10.2026 00:06' },
]);

describeIntegration('15-minute reservations: absolute storage and Moscow UI in every work stage', () => {
  let prisma: PrismaClient, h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma);
    // A configurable display zone must not change a time explicitly labelled МСК.
    vi.stubEnv('APP_TIMEZONE', 'Asia/Omsk'); resetConfigCache();
    h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Тестовый сотрудник', [UserRole.ADMIN]);
    h.services.max = { api: {
      getMyInfo: vi.fn(async () => ({ username: 'test_bot' })),
      getChatMembers: vi.fn(async (_chat, args) => ({ members: args.user_ids.map((id: number) => ({ user_id: id, is_bot: false })) })),
    } } as never;
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache(); });

  it('runs the read-only diagnostic without disclosing text, contacts, credentials or raw errors', async () => {
    const secret = 'test-only-do-not-output-secret';
    const residentText = 'Секретный текст жителя';
    const incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: residentText });
    await prisma.incident.update({ where: { id: incident.id }, data: { publicCode: 'INC-000164' } });
    await prisma.incidentHistory.create({ data: { incidentId: incident.id, action: 'TAKEN_IN_WORK',
      metadata: { until: '+79001234567', responder: residentText, secret } } });
    await prisma.outboundMessage.create({ data: { incidentId: incident.id, dedupeKey: 'diagnostic-private-test',
      targetType: 'chat', targetId: TEST_CHATS.sector, payload: { text: `${residentText} +79001234567 ${secret}\nДо 30.09.2026 19:56 (МСК)` },
      attachments: [], lastError: secret } });
    const before = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    const beforeJobs = await prisma.outboundMessage.findMany({ where: { incidentId: incident.id } });
    const output = execFileSync(process.execPath, [resolve('tools/diagnose-incident-time.cjs')], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL!, BOT_TOKEN: secret,
        WEBHOOK_SECRET: secret, TIME_DIAGNOSTIC_CODE: 'INC-000164' }, encoding: 'utf8',
    });
    for (const forbidden of [secret, residentText, '+79001234567', process.env.TEST_DATABASE_URL!]) expect(output).not.toContain(forbidden);
    const result = JSON.parse(output);
    expect(result.incident.publicCode).toBe('INC-000164');
    expect(result.sectorAndReviewLeaseMinutes).toBe(15);
    expect(result.distributionClaimMinutes).toBe(15);
    expect(result.fixture.rendered).toContain('30.09.2026 16:56 (МСК)');
    expect(result.history.find((entry: { action: string }) => entry.action === 'TAKEN_IN_WORK').untilUtc).toBeNull();
    expect(result.delivery.some((entry: { renderedLeaseTime: string }) => entry.renderedLeaseTime === '30.09.2026 19:56')).toBe(true);
    expect(await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).toEqual(before);
    expect(await prisma.outboundMessage.findMany({ where: { incidentId: incident.id } })).toEqual(beforeJobs);
  });

  it.each(cases)('$kind: $takeAt -> $label MSK; warns and expires at the stored instant', async c => {
    vi.setSystemTime(new Date(c.takeAt));
    const incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Не работает фонарь у дома 1' });
    const chat = c.kind === 'distribution' ? TEST_CHATS.distribution : c.kind === 'sector' ? TEST_CHATS.sector : TEST_CHATS.review;
    if (c.kind !== 'distribution') {
      const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
      await h.services.distribution.assign(incident.id, group.id, actor);
      if (c.kind === 'review') await h.services.answers.submit(incident.id, actor, 'Фонарь восстановлен.', []);
    }
    if (c.kind === 'distribution') await h.services.distributionQueue.claim(actor, chat, incident.id, true);
    else if (c.kind === 'sector') await h.services.sector.takeInWork(incident.id, actor);
    else await h.services.workQueues.claimReview(actor, chat, incident.id);

    const action = c.kind === 'sector' ? SECTOR_LEASE_ACTION : REVIEW_LEASE_ACTION;
    const readUntil = async () => c.kind === 'distribution'
      ? (await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).distributionClaimUntil
      : (await prisma.actionLock.findFirst({ where: { incidentId: incident.id, action } }))?.lockedUntil;
    expect((await readUntil())?.toISOString()).toBe(c.until);
    expect((await readUntil())!.getTime() - Date.now()).toBe(15 * 60_000);
    const event = await prisma.incidentHistory.findFirstOrThrow({ where: { incidentId: incident.id,
      action: c.kind === 'distribution' ? 'DISTRIBUTION_CLAIMED' : c.kind === 'sector' ? 'TAKEN_IN_WORK' : 'REVIEW_CLAIMED' } });
    expect((event.metadata as { until: string }).until).toBe(c.until);

    // PostgreSQL session timezone must not reinterpret application Date values.
    for (const zone of ['UTC', 'Europe/Moscow']) await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
      const key = `timezone-probe:${zone}`;
      await tx.actionLock.create({ data: { key, action: 'timezone-probe', maxUserId: 0n, lockedUntil: new Date(c.until) } });
      expect((await tx.actionLock.findUniqueOrThrow({ where: { key } })).lockedUntil.toISOString()).toBe(c.until);
      const raw = await tx.$queryRaw<Array<{ stored: string }>>`
        SELECT to_char("lockedUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS stored FROM "ActionLock" WHERE key = ${key}`;
      expect(raw[0]!.stored + 'Z').toBe(c.until);
      await tx.actionLock.delete({ where: { key } });
    });
    const fresh = (await h.services.repository.findById(incident.id))!;
    const lease = c.kind === 'distribution' ? { name: actor.displayName, until: fresh.distributionClaimUntil! }
      : await leaseView(prisma, incident.id, action);
    const expected = `До ${c.label} (МСК)`;
    const card = c.kind === 'distribution' ? distributionCard(fresh) : c.kind === 'sector'
      ? sectorCard(fresh, fresh.assignedGroup!, lease) : reviewCard(fresh, fresh.answers.at(-1)!, fresh.assignedGroup, lease);
    expect(card).toContain(expected);
    expect(incidentLookupCard(fresh, lease, c.kind === 'distribution')).toContain(expected);
    if (c.kind !== 'distribution') {
      await h.services.workQueues.list(actor, chat);
      expect(h.messages.toChat(chat).at(-1)!.message.text).toContain(expected);
      expect(await workPanelText(prisma, chat)).toContain('Свободны: 0 · В работе: 1');
    } else expect((await queueSnapshot(prisma, new Date())).reserved).toBe(1);
    await invitePersonalWork(h.services, actor, chat, incident.id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id } });
    await enterPersonalWork(h.services, actor, item.id);
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain(expected);
    expect((await readUntil())?.toISOString()).toBe(c.until); // Opening the card does not renew the reservation.

    const warnings = () => prisma.outboundMessage.findMany({ where: { dedupeKey: { startsWith: `private-warning:${item.id}:` } } });
    vi.setSystemTime(Date.parse(c.until) - 120_001);
    await sweepPersonalWork(h.services); expect(await warnings()).toHaveLength(0);
    vi.setSystemTime(Date.parse(c.until) - 120_000);
    await sweepPersonalWork(h.services); await sweepPersonalWork(h.services);
    expect(await warnings()).toHaveLength(1);
    expect(((await warnings())[0]!.payload as { text: string }).text).toContain(`${c.label} (МСК)`);

    const sweep = () => c.kind === 'distribution' ? h.services.distributionQueue.sweep() : h.services.workQueues.sweep();
    vi.setSystemTime(Date.parse(c.until) - 1); await sweep();
    expect((await readUntil())?.toISOString()).toBe(c.until);
    vi.setSystemTime(Date.parse(c.until)); await sweep();
    expect(await readUntil()).toBeFalsy();
    if (c.kind !== 'distribution') expect(await workPanelText(prisma, chat)).toContain('Свободны: 1 · В работе: 0');
    else expect((await queueSnapshot(prisma, new Date())).reserved).toBe(0);
    if (c.kind === 'sector') {
      const released = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(released.status).toBe('ASSIGNED'); expect(released.currentResponderId).toBeNull();
    }
    await h.services.sla.sweep(new Date());
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).isOverdue).toBe(false);
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'SLA_REMINDER_24H' } })).toBe(0);
    expect(getConfig().APP_TIMEZONE).toBe('Asia/Omsk');
  });
});
