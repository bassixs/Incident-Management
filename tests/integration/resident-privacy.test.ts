import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { UserRole, type PrismaClient } from '@prisma/client';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { TEST_CHATS } from '../helpers/setup-env';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';

describeIntegration('minimal resident data and mandatory staff screening', () => {
  let prisma: PrismaClient; let h: TestHarness;
  beforeAll(async () => { pushSchemaOnce(); prisma = createTestPrisma(); await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); });
  it('starts without a profile, phone or consent; old consent button is harmless', async () => {
    const user = await h.services.users.upsertFromMax({ user_id: 555, name: 'Иванов Иван Иванович', username: 'private' });
    expect(user.displayName).toBe('Житель'); expect(user.username).toBeNull();
    const actor = { userId: user.id, maxUserId: 555n, displayName: 'Житель', roles: [UserRole.REQUESTER], role: 'REQUESTER' };
    const context = { services: h.services, actor, chatId: 555n, callbackId: 'new', messageId: undefined };
    await handleUserCallback(context, { kind: 'user', action: 'new' });
    const session = await prisma.operatorSession.findFirstOrThrow();
    expect(session.type).toBe('WAITING_INCIDENT_SELECTION'); expect(session.data).toEqual({});
    await handleUserCallback(context, { kind: 'user', action: 'accept-consent' });
    expect(await prisma.legalAcceptance.count()).toBe(0);
  });
  it('rejects personal text before creating incident and quota; ignores supplied legacy profile values', async () => {
    await expect(h.services.incidents.create({ requester: { maxUserId: 555n }, text: 'Паспорт 45 12 123456, телефон +79001234567' })).rejects.toThrow('персональные');
    expect(await prisma.incident.count()).toBe(0);
    const incident = await h.services.incidents.create({ requester: { maxUserId: 555n, name: 'Иванов Иван Иванович', phone: '+79001234567' }, text: 'Яма у дома 12 на улице Ленина' });
    expect(incident.requesterName).toBe('Житель'); expect(incident.requesterPhone).toBeNull();
    expect((await prisma.user.findFirstOrThrow()).requesterName).toBeNull();
  });
  it('cannot distribute before checking; another employee cannot take over the check', async () => {
    const incident = await h.services.incidents.create({ requester: { maxUserId: 555n }, text: 'Не работает освещение во дворе' });
    const actor = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    const second = await actorFor(prisma, 557n, 'Другой диспетчер', [UserRole.DISPATCHER]);
    const group = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'FACILITY' } });
    await h.services.distributionQueue.claim(actor, TEST_CHATS.distribution, incident.id);
    await expect(h.services.distribution.assign(incident.id, group.id, actor)).rejects.toThrow('персональных');
    await expect(h.services.distribution.confirmPrivacyCheck(incident.id, second)).rejects.toThrow();
    await h.services.distribution.confirmPrivacyCheck(incident.id, actor);
    await h.services.distribution.confirmPrivacyCheck(incident.id, actor);
    expect(await prisma.incidentHistory.count({ where: { action: 'PRIVACY_CHECK_PASSED' } })).toBe(1);
    await h.services.distribution.assign(incident.id, group.id, actor);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('ASSIGNED');
  });
  it('does not allow a resident to approve screening by forging a callback', async () => {
    const incident = await h.services.incidents.create({ requester: { maxUserId: 555n }, text: 'Не работает освещение во дворе' });
    const actor = await actorFor(prisma, 555n, 'Житель', []);
    await expect(handleIncidentCallback({ services: h.services, actor, chatId: 555n, messageId: undefined }, { kind: 'incident', action: 'privacy-pass', incidentId: incident.id, argument: 'confirm' })).rejects.toThrow();
    expect(await prisma.incidentHistory.count({ where: { action: 'PRIVACY_CHECK_PASSED' } })).toBe(0);
  });
  it('removes rejected content and photo references instead of retaining the personal material', async () => {
    const incident = await h.services.incidents.create({ requester: { maxUserId: 555n }, text: 'Не работает освещение во дворе' });
    await prisma.incident.update({ where: { id: incident.id }, data: { text: 'Материал, обнаруженный при ручной проверке' } });
    await prisma.incidentAttachment.create({ data: { incidentId: incident.id, type: 'IMAGE', storageKey: 'max-photo:private-photo', maxToken: 'private-photo' } });
    const actor = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    await h.services.distributionQueue.claim(actor, TEST_CHATS.distribution, incident.id);
    await h.services.distribution.reject(incident.id, 'Фотография содержит персональные данные. Отправьте сообщение без них.', actor);
    const row = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(row.status).toBe('REJECTED'); expect(row.text).toBe('Содержание отклонённого сообщения удалено.');
    expect(await prisma.incidentAttachment.count({ where: { incidentId: incident.id } })).toBe(0);
    expect(JSON.stringify(await prisma.outboundMessage.findMany({ where: { incidentId: incident.id } }), (_k,v) => typeof v === 'bigint' ? String(v) : v)).not.toContain('private-photo');
  });
  it('keeps only a rejection marker in the durable inbox, including concurrent redelivery', async () => {
    const dispatcher = new UpdateDispatcher(prisma, {} as never, 2);
    const update = { update_type: 'message_created', timestamp: 100, message: { sender: { user_id: 555, name: 'Иванов Иван Иванович', username: 'secret' }, recipient: { chat_type: 'dialog', chat_id: 555 }, body: { mid: 'private-input', text: 'паспорт 45 12 123456' } } };
    const results = await Promise.all([dispatcher.reserve(update as never), dispatcher.reserve(update as never)]);
    expect(results.filter(r => r.fresh)).toHaveLength(1);
    const payload = JSON.stringify((await prisma.inboundUpdate.findFirstOrThrow()).payload);
    expect(payload).toContain('privacyRejected'); expect(payload).not.toContain('123456'); expect(payload).not.toContain('Иванов'); expect(payload).not.toContain('secret');
  });
});
