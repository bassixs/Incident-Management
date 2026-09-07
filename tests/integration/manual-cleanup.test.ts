import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CleanupService, CLEANUP_KEY, cleanupPreviewText } from '../../src/maintenance/cleanup.service';
import { parseCleanupRange } from '../../src/maintenance/cleanup-range';
import { getConfig, loadConfig } from '../../src/config';
import { createHarness, createTestPrisma, describeIntegration, ensureUser, pushSchemaOnce, resetDatabase } from '../helpers/integration';
import type { MediaStorage } from '../../src/media/media-storage.interface';
import { photoReference } from '../../src/media/max-photo-reference';
import { COMMANDS } from '../../src/bot/commands';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { resolveActor } from '../../src/bot/handlers/helpers';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { LegalAcceptanceService } from '../../src/legal/legal-acceptance.service';

const actor = { maxUserId: 9001n, displayName: 'Администратор' };
const chat = -1005n;
const since = new Date(Date.now() - 3_600_000);
describeIntegration('manual cleanup with separate data and profile commands', () => {
  let prisma: PrismaClient;
  let service: CleanupService;
  let remove: ReturnType<typeof vi.fn>;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => {
    await resetDatabase(prisma); remove = vi.fn(async () => undefined);
    service = new CleanupService(prisma, { remove } as unknown as MediaStorage, getConfig());
    service.start(work => work()); service.stop();
    await ensureUser(prisma, actor.maxUserId, actor.displayName);
  });
  afterEach(() => service.stop());
  afterAll(() => prisma.$disconnect());
  async function resident(id: bigint) {
    const user = await ensureUser(prisma, id, `Житель ${id}`);
    return prisma.user.update({ where: { id: user.id }, data: { createdAt: since, requesterName: 'Иван Иванов', requesterPhone: '+79991234567' } });
  }
  async function incident(user: Awaited<ReturnType<typeof resident>>, suffix: string, createdAt = since) {
    return prisma.incident.create({ data: { publicCode: `INC-20260907-${suffix}`, requesterId: user.id, requesterMaxUserId: user.maxUserId,
      requesterName: 'Имя в обращении', requesterPhone: '+79990000000', text: 'Проблема', deadlineAt: new Date(Date.now() + 72 * 3_600_000), createdAt } });
  }
  async function consent(userId: string, id: bigint) {
    return prisma.legalAcceptance.create({ data: { userId, maxUserId: id, type: 'PERSONAL_DATA_CONSENT', documentVersion: '1.0', documentUrl: 'https://example.test/consent',
      documentSha256: 'a'.repeat(64), confirmationText: 'Согласен' } });
  }
  async function planState() { return JSON.parse((await prisma.systemSetting.findUniqueOrThrow({ where: { key: CLEANUP_KEY } })).value); }
  async function confirm(plan: { kind: 'data' | 'users'; token: string }) { await service.confirm(plan.kind, plan.token, actor, chat); await service.tick(); }

  it('previews without mutations, deletes selected incident graph and deliveries, preserves profiles and settings', async () => {
    const user = await resident(1001n);
    const selected = await incident(user, '0001');
    const kept = await incident(user, '0002', new Date(Date.now() - 100 * 86_400_000));
    const staff = await ensureUser(prisma, 1002n, 'Автоматический исполнитель');
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: selected.id, version: 1, text: 'Ответ', createdByUserId: staff.id } });
    await prisma.answerAttachment.create({ data: { answerId: answer.id, type: 'FILE', storageKey: 'answers/deleted.pdf' } });
    await prisma.incidentAttachment.createMany({ data: [
      { incidentId: selected.id, type: 'IMAGE', storageKey: photoReference('max-photo-token') },
      { incidentId: selected.id, type: 'FILE', storageKey: 'shared/object.pdf' },
      { incidentId: kept.id, type: 'FILE', storageKey: 'shared/object.pdf' },
    ] });
    await prisma.outboundMessage.create({ data: { targetType: 'chat', targetId: -1010n, incidentId: selected.id, answerId: answer.id, payload: { text: 'Ответ' }, attachments: [] } });
    await prisma.outboundMessage.create({ data: { dedupeKey: 'cached-lookup', targetType: 'chat', targetId: -1005n, payload: { text: `Карточка ${selected.publicCode}` }, attachments: [] } });
    await prisma.incidentHistory.create({ data: { incidentId: selected.id, action: 'CREATED' } });
    await prisma.operatorSession.create({ data: { maxUserId: staff.maxUserId, chatId: -1010n, incidentId: selected.id, type: 'WAITING_FOR_ANSWER', expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.actionLock.create({ data: { key: 'selected', incidentId: selected.id, maxUserId: staff.maxUserId, action: 'answer', lockedUntil: new Date() } });
    await prisma.incidentCounter.create({ data: { day: '20260907', lastNumber: 100 } });
    await prisma.systemSetting.create({ data: { key: 'keep-setting', value: 'keep' } });
    const plan = await service.preview('data', actor, chat, parseCleanupRange('today'));
    expect(plan.counts).toMatchObject({ incidents: 1, active: 1, profiles: 0 });
    expect(cleanupPreviewText(plan)).toContain('незавершённых: 1');
    expect(await prisma.incident.count()).toBe(2); expect(remove).not.toHaveBeenCalled();
    await confirm(plan);
    expect((await planState()).status).toBe('DONE');
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.incidentAnswer.count()).toBe(0);
    expect(await prisma.operatorSession.count()).toBe(0); expect(await prisma.actionLock.count()).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { incidentId: selected.id } })).toBe(0);
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: 'cached-lookup' } })).toBeNull();
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.systemSetting.findUnique({ where: { key: 'keep-setting' } })).not.toBeNull();
    expect((await prisma.incidentCounter.findUniqueOrThrow({ where: { day: '20260907' } })).lastNumber).toBe(100);
    expect(remove.mock.calls).toEqual([['answers/deleted.pdf']]);
    expect(await prisma.adminAuditLog.count({ where: { action: 'MANUAL_CLEANUP' } })).toBe(1);
    // Employees whose only business record was deleted are still protected.
    const reset = await service.preview('users', actor, chat); await confirm(reset);
    expect(await prisma.user.findUnique({ where: { id: staff.id } })).not.toBeNull();
  });

  it('resets all resident profiles, deletes only orphans, preserves incidents, staff, bans and clarification sessions', async () => {
    const linked = await resident(1101n); const orphan = await resident(1102n);
    const storedStaff = await ensureUser(prisma, 1103n, 'Сотрудник', ['RESPONDER']);
    const kept = await incident(linked, '0001');
    await consent(linked.id, linked.maxUserId); await consent(orphan.id, orphan.maxUserId); await consent(storedStaff.id, storedStaff.maxUserId);
    await prisma.ban.create({ data: { maxUserId: orphan.maxUserId, reason: 'Тест' } });
    await prisma.operatorSession.createMany({ data: [
      { maxUserId: orphan.maxUserId, chatId: orphan.maxUserId, type: 'WAITING_INCIDENT_TEXT', expiresAt: new Date(Date.now() + 60_000) },
      { maxUserId: linked.maxUserId, chatId: linked.maxUserId, type: 'WAITING_CLARIFICATION_REPLY', incidentId: kept.id, expiresAt: new Date(Date.now() + 60_000) },
    ] });
    const plan = await service.preview('users', actor, chat);
    expect(plan.counts).toMatchObject({ profiles: 4, deletedProfiles: 1, consents: 3, incidents: 0 });
    await confirm(plan);
    expect(await prisma.user.findUnique({ where: { id: orphan.id } })).toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ requesterName: null, requesterPhone: null, username: null });
    expect(await prisma.incident.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ requesterName: 'Имя в обращении', requesterPhone: '+79990000000' });
    expect(await prisma.legalAcceptance.count()).toBe(0); expect(await prisma.ban.count()).toBe(1);
    expect(await prisma.operatorSession.count()).toBe(1); expect(await prisma.user.findUnique({ where: { id: storedStaff.id } })).not.toBeNull();
  });

  it('requires admin, analytics chat, matching owner, command, token and expiry', async () => {
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    const other = { maxUserId: 1200n, displayName: 'Другой админ' };
    await ensureUser(prisma, other.maxUserId, other.displayName, ['ADMIN']);
    await expect(service.preview('users', { maxUserId: 9002n, displayName: 'Распределитель' }, chat)).rejects.toThrow('администраторам');
    await expect(service.authorize(actor, chat, true)).rejects.toThrow('системном');
    await expect(service.confirm('data', plan.token, actor, -1001n)).rejects.toThrow('системном');
    await expect(service.confirm('data', plan.token, other, chat)).rejects.toThrow('недействительно');
    await expect(service.confirm('users', plan.token, actor, chat)).rejects.toThrow('недействительно');
    await expect(service.confirm('data', plan.token, actor, chat, new Date(Date.now() + 11 * 60_000))).rejects.toThrow('истёк');
    await expect(service.confirm('data', '0'.repeat(16), actor, chat)).rejects.toThrow('недействительно');
    expect((await planState()).status).toBe('PREVIEW');
  });

  it('allows only one concurrent confirmation and one committed deletion after repeated worker ticks', async () => {
    const user = await resident(1301n); await incident(user, '0001');
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    const outcomes = await Promise.allSettled([service.confirm('data', plan.token, actor, chat), service.confirm('data', plan.token, actor, chat)]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    await Promise.all([service.tick(), service.tick()]); await service.tick();
    expect(await prisma.adminAuditLog.count({ where: { action: 'MANUAL_CLEANUP' } })).toBe(1);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `manual-cleanup:${plan.token}:done` } })).toBe(1);
  });

  it('refuses stale previews when a staff answer or resident profile changes', async () => {
    const user = await resident(1401n); const item = await incident(user, '0001');
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    await prisma.incidentAnswer.create({ data: { incidentId: item.id, version: 1, text: 'Новый ответ', createdByUserId: (await ensureUser(prisma, 9004n, 'Исполнитель')).id } });
    await confirm(plan);
    expect((await planState()).status).toBe('FAILED'); expect(await prisma.incident.count()).toBe(1); expect(remove).not.toHaveBeenCalled();
    const reset = await service.preview('users', actor, chat);
    await prisma.user.update({ where: { id: user.id }, data: { requesterPhone: '+79998888888' } });
    await confirm(reset); expect((await planState()).status).toBe('FAILED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).requesterPhone).toBe('+79998888888');
  });

  it('freezes all-time selection at preview and never includes newer incidents', async () => {
    const user = await resident(1501n); await incident(user, '0001');
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    const later = await incident(user, '0002', new Date(new Date(plan.until).getTime() + 1));
    await confirm(plan);
    expect((await planState()).status).toBe('DONE'); expect(await prisma.incident.findUnique({ where: { id: later.id } })).not.toBeNull();
  });

  it('recovers confirmed jobs after a worker restart and retries file failure without deleting twice', async () => {
    const user = await resident(1601n); const item = await incident(user, '0001');
    await prisma.incidentAttachment.create({ data: { incidentId: item.id, type: 'FILE', storageKey: 'incident/local.pdf' } });
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    await service.confirm('data', plan.token, actor, chat);
    service = new CleanupService(prisma, { remove } as unknown as MediaStorage, getConfig()); service.start(work => work()); service.stop();
    remove.mockRejectedValueOnce(new Error('disk unavailable'));
    await service.tick(); expect((await planState()).status).toBe('FILES'); expect(await prisma.incident.count()).toBe(0);
    await expect(service.preview('users', actor, chat)).rejects.toThrow('ещё выполняется');
    const pending = await planState(); pending.retryAt = new Date(0).toISOString();
    await prisma.systemSetting.update({ where: { key: CLEANUP_KEY }, data: { value: JSON.stringify(pending) } });
    await service.tick(); expect((await planState()).status).toBe('DONE');
    expect(await prisma.adminAuditLog.count({ where: { action: 'MANUAL_CLEANUP' } })).toBe(1);
  });

  it('does not clear a resident with queued incoming messages or overlap scheduled retention', async () => {
    const user = await resident(1701n); await incident(user, '0001');
    const reset = await service.preview('users', actor, chat);
    await prisma.inboundUpdate.create({ data: { externalUpdateKey: 'pending', partitionKey: `user:${user.maxUserId}`, updateType: 'message_created', payload: {} } });
    await confirm(reset); expect((await planState()).status).toBe('FAILED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).requesterName).not.toBeNull();
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    await prisma.systemSetting.create({ data: { key: 'maintenance.incident-retention', value: 'active' } });
    await confirm(plan); expect((await planState()).status).toBe('FAILED'); expect(await prisma.incident.count()).toBe(1);
  });

  it('rolls the entire deletion back if recording the audit fails', async () => {
    const user = await resident(1801n); const item = await incident(user, '0001');
    await prisma.incidentAttachment.create({ data: { incidentId: item.id, type: 'FILE', storageKey: 'keep-on-rollback.pdf' } });
    const plan = await service.preview('data', actor, chat, parseCleanupRange('all'));
    await prisma.$executeRawUnsafe(`CREATE FUNCTION cleanup_test_reject_audit() RETURNS trigger AS $$ BEGIN IF NEW.action = 'MANUAL_CLEANUP' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER cleanup_test_reject BEFORE INSERT ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION cleanup_test_reject_audit()');
    try {
      await confirm(plan);
      expect((await planState()).status).toBe('FAILED');
      expect(await prisma.incident.count()).toBe(1); expect(await prisma.incidentAttachment.count()).toBe(1);
      expect(remove).not.toHaveBeenCalled(); expect(await prisma.adminAuditLog.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER cleanup_test_reject ON "AdminAuditLog"');
      await prisma.$executeRawUnsafe('DROP FUNCTION cleanup_test_reject_audit()');
    }
  });

  it('routes two independent commands: period buttons for data, profile preview for users, no deletion on either', async () => {
    const user = await resident(1901n); await incident(user, '0001');
    const harness = await createHarness(prisma);
    const context = { services: harness.services, actor: { ...actor, userId: (await prisma.user.findUniqueOrThrow({ where: { maxUserId: actor.maxUserId } })).id, roles: ['ADMIN' as const], role: 'ADMIN' },
      chatId: chat, isDialog: false, args: [] as string[] };
    await COMMANDS.clear_data!(context);
    const menu = harness.messages.sent.at(-1)!;
    expect(JSON.stringify(menu.message.keyboard)).toContain('cleanup:90d');
    expect(await prisma.systemSetting.findUnique({ where: { key: CLEANUP_KEY } })).toBeNull();
    await COMMANDS.clear_users!(context);
    expect((await planState()).kind).toBe('users');
    expect(harness.messages.sent.at(-1)!.message.text).toContain('/clear_users confirm');
    expect(await prisma.incident.count()).toBe(1); expect(await prisma.user.count()).toBe(2);
    await expect(COMMANDS.clear_users!({ ...context, isDialog: true })).rejects.toThrow('системном');
  });

  it('preserves a newly joined employee with automatic rights and no authored records yet', async () => {
    const employee = await resident(1951n);
    await prisma.inboundUpdate.create({ data: { externalUpdateKey: 'member-added', partitionKey: `user:${employee.maxUserId}`, status: 'PROCESSED', updateType: 'user_added',
      payload: { update_type: 'user_added', chat_id: Number(chat), user: { user_id: Number(employee.maxUserId) } } } });
    const plan = await service.preview('users', actor, chat);
    expect(plan.counts.profiles).toBe(2); await confirm(plan);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: employee.id } })).toMatchObject({ requesterName: null, requesterPhone: null, displayName: employee.displayName });
  });

  it('resets the confirming database administrator through real commands and restarts consent, name and phone collection without losing work access', async () => {
    const admin = await resident(1961n);
    await prisma.user.update({ where: { id: admin.id }, data: { roles: ['ADMIN'], username: 'staff-account' } });
    const harness = await createHarness(prisma);
    harness.services.cleanup.start(work => work()); harness.services.cleanup.stop();
    harness.services.legal = new LegalAcceptanceService(prisma, loadConfig({ ...process.env,
      LEGAL_CONSENT_REQUIRED: 'true', LEGAL_DOCUMENTS_BASE_URL: 'https://example.test/documents/',
      LEGAL_DOCUMENT_VERSION: '1.0', LEGAL_USER_AGREEMENT_VERSION: '1.1',
      LEGAL_USER_AGREEMENT_SHA256: 'a'.repeat(64), LEGAL_PRIVACY_POLICY_SHA256: 'b'.repeat(64), LEGAL_PERSONAL_DATA_CONSENT_SHA256: 'c'.repeat(64),
    }));
    const evidence = { userId: admin.id, maxUserId: admin.maxUserId, sourceChatId: admin.maxUserId };
    await harness.services.legal.acceptUserAgreement({ ...evidence, sourceCallbackId: 'admin-old-agreement' });
    await harness.services.legal.acceptPersonalDataConsent({ ...evidence, sourceCallbackId: 'admin-old-consent' });
    await prisma.operatorSession.createMany({ data: [
      { maxUserId: admin.maxUserId, chatId: admin.maxUserId, type: 'WAITING_INCIDENT_CONFIRMATION', data: { requesterName: 'Старое имя', requesterPhone: '+79991234567' }, expiresAt: new Date(Date.now() + 60_000) },
      { maxUserId: admin.maxUserId, chatId: chat, type: 'WAITING_REPORT_PERIOD', expiresAt: new Date(Date.now() + 60_000) },
    ] });
    const sender = { user_id: Number(admin.maxUserId), name: admin.displayName, username: 'staff-account', is_bot: false, last_activity_time: 0 };
    const command = (text: string) => handleMessageUpdate(harness.services, { update: { update_type: 'message_created',
      message: { sender, recipient: { chat_type: 'chat', chat_id: Number(chat) }, body: { mid: text, text } } } } as never);
    await command('/clear_users');
    const plan = await planState();
    expect(plan.counts.deletedProfiles).toBe(0);
    await command(`/clear_users confirm ${plan.token}`);
    await harness.services.cleanup.tick();
    expect((await planState()).status).toBe('DONE');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({
      roles: ['ADMIN'], displayName: admin.displayName, username: 'staff-account', requesterName: null, requesterPhone: null,
    });
    expect(await harness.services.sessions.find(admin.maxUserId, chat)).toMatchObject({ type: 'WAITING_REPORT_PERIOD' });
    expect(await harness.services.sessions.find(admin.maxUserId, admin.maxUserId)).toBeNull();
    await expect(harness.services.cleanup.authorize({ maxUserId: admin.maxUserId, displayName: admin.displayName }, chat)).resolves.toBeUndefined();
    const identity = await resolveActor(harness.services, sender);
    const context = { services: harness.services, actor: identity, chatId: admin.maxUserId, callbackId: 'new-start', messageId: undefined };
    await handleUserCallback(context, { kind: 'user', action: 'new' });
    expect(await harness.services.legal.hasCurrentAccess(admin.id)).toBe(false);
    expect(await harness.services.sessions.find(admin.maxUserId, admin.maxUserId)).toBeNull();
    await handleUserCallback({ ...context, callbackId: 'admin-new-agreement' }, { kind: 'user', action: 'accept-agreement' });
    await handleUserCallback({ ...context, callbackId: 'admin-new-consent' }, { kind: 'user', action: 'accept-consent' });
    expect(await harness.services.sessions.find(admin.maxUserId, admin.maxUserId)).toMatchObject({ type: 'WAITING_REQUESTER_NAME' });
    const reply = (text: string) => handleRequesterMessage(harness.services, identity, admin.maxUserId,
      { body: { mid: text, text }, recipient: { chat_type: 'dialog', chat_id: Number(admin.maxUserId) }, sender } as never);
    await reply('Петров Пётр Петрович');
    expect(await harness.services.sessions.find(admin.maxUserId, admin.maxUserId)).toMatchObject({ type: 'WAITING_REQUESTER_PHONE' });
    await reply('+79998887766');
    expect(await harness.services.sessions.find(admin.maxUserId, admin.maxUserId)).toMatchObject({
      type: 'WAITING_INCIDENT_SELECTION', data: { requesterName: 'Петров Пётр Петрович', requesterPhone: '+7 999 888-77-66' },
    });
  });
});
