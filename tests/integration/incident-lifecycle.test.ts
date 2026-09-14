import { incidentWorkday } from '../../src/utils/work-calendar';
import { AnswerStatus, IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { HistoryAction } from '../../src/incidents/incident-history.service';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import type { Message } from '../../src/max/max-types';
import { ConflictError, RateLimitError } from '../../src/utils/errors';
import * as configModule from '../../src/config';
import { rulesText } from '../../src/bot/views/cards';
import {
  actorFor,
  CATEGORY_CODES,
  createHarness,
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
  seedCategories,
  type TestHarness,
} from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('incident lifecycle (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let harness: TestHarness;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    harness = await createHarness(prisma);
  });

  const requesterA = () => ({ maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+7 900 111-22-33' });
  const requesterB = () => ({ maxUserId: TEST_USERS.requesterB, name: 'Пётр Петров', phone: '+7 900 444-55-66' });

  async function facility() {
    return (await harness.services.responsibleGroups.findByCode(CATEGORY_CODES.facility))!;
  }

  function requesterMessage(text: string): Message {
    return {
      sender: { user_id: Number(TEST_USERS.requesterA), name: 'Профиль MAX', username: null },
      recipient: { chat_id: Number(TEST_USERS.requesterA), chat_type: 'dialog' },
      body: { mid: `mid-${text}`, text, attachments: null },
    } as unknown as Message;
  }

  function requesterContactMessage(contactMaxUserId = TEST_USERS.requesterA): Message {
    return {
      sender: { user_id: Number(TEST_USERS.requesterA), name: 'Профиль MAX', username: null },
      recipient: { chat_id: Number(TEST_USERS.requesterA), chat_type: 'dialog' },
      body: {
        mid: 'mid-contact',
        text: '',
        attachments: [
          {
            type: 'contact',
            payload: {
              vcf_info: 'BEGIN:VCARD\nFN:Иванов Иван\nTEL:+79001234567\nEND:VCARD',
              tam_info: {
                user_id: Number(contactMaxUserId),
                name: 'Иванов Иван',
                username: null,
              },
            },
          },
        ],
      },
    } as unknown as Message;
  }

  it('requires and stores full name and phone before an incident is created', async () => {
    const actor = await actorFor(prisma, TEST_USERS.requesterA, 'Профиль MAX', []);
    if ((await harness.services.legal.status(actor.userId)).required) {
      const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
      await harness.services.legal.acceptUserAgreement(evidence);
      await harness.services.legal.acceptPersonalDataConsent(evidence);
    }
    await harness.services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId: actor.maxUserId,
      type: 'WAITING_REQUESTER_NAME',
    });

    await handleRequesterMessage(
      harness.services,
      actor,
      actor.maxUserId,
      requesterMessage('Иванов Иван Иванович'),
    );
    expect((await harness.services.sessions.find(actor.maxUserId, actor.maxUserId))?.type).toBe(
      'WAITING_REQUESTER_PHONE',
    );

    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('телефона нет'));
    expect((await harness.services.sessions.find(actor.maxUserId, actor.maxUserId))?.type).toBe(
      'WAITING_REQUESTER_PHONE',
    );
    expect(await prisma.incident.count()).toBe(0);

    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('8 (900) 123-45-67'));
    const selection = await harness.services.sessions.find(actor.maxUserId, actor.maxUserId);
    expect(selection?.type).toBe('WAITING_INCIDENT_SELECTION');
    expect(harness.services.sessions.readData(selection!).requesterPhone).toBe('+7 900 123-45-67');

    await harness.services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_TEXT',
      data: {
        ...harness.services.sessions.readData(selection!),
        problemMunicipalityCode: 'KALUGA_CITY',
        problemMunicipalityName: 'Город Калуга',
      },
    });
    await handleRequesterMessage(
      harness.services,
      actor,
      actor.maxUserId,
      requesterMessage('Не работает фонарь.'),
    );

    expect(await prisma.incident.count()).toBe(0);
    const preview = await harness.services.sessions.find(actor.maxUserId, actor.maxUserId);
    expect(preview?.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(harness.services.sessions.readData(preview!).draftText).toBe('Не работает фонарь.');

    await handleUserCallback(
      {
        services: harness.services,
        actor,
        chatId: actor.maxUserId,
        messageId: 'preview-card',
        callbackId: 'confirm-draft',
      },
      { kind: 'user', action: 'draft-confirm' },
    );

    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.requesterName).toBe('Иванов Иван Иванович');
    expect(incident.requesterPhone).toBe('+7 900 123-45-67');

    const profile = await prisma.user.findUniqueOrThrow({ where: { maxUserId: actor.maxUserId } });
    expect(profile.requesterName).toBe('Иванов Иван Иванович');
    expect(profile.requesterPhone).toBe('+7 900 123-45-67');

    await handleUserCallback(
      {
        services: harness.services,
        actor,
        chatId: actor.maxUserId,
        messageId: 'main-menu',
        callbackId: 'new-with-profile',
      },
      { kind: 'user', action: 'new' },
    );
    const reused = await harness.services.sessions.find(actor.maxUserId, actor.maxUserId);
    expect(reused?.type).toBe('WAITING_INCIDENT_SELECTION');
    expect(harness.services.sessions.readData(reused!)).toMatchObject({
      requesterName: 'Иванов Иван Иванович',
      requesterPhone: '+7 900 123-45-67',
    });
    expect(harness.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('Использую сохранённые');
  });

  it('asks for a typed name first and offers the contact button only for the phone without replacing the name', async () => {
    const actor = await actorFor(prisma, TEST_USERS.requesterA, 'Профиль MAX', []);
    if ((await harness.services.legal.status(actor.userId)).required) {
      const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
      await harness.services.legal.acceptUserAgreement(evidence);
      await harness.services.legal.acceptPersonalDataConsent(evidence);
    }
    await handleUserCallback({ services: harness.services, actor, chatId: actor.maxUserId,
      messageId: 'new-menu', callbackId: 'new-name-first' }, { kind: 'user', action: 'new' });
    const namePrompt = harness.messages.toUser(actor.maxUserId).at(-1)!.message;
    expect(namePrompt.text).toContain('Шаг 1.');
    expect(namePrompt.text).not.toContain('Поделиться контактом');
    expect(namePrompt.keyboard).toBeUndefined();

    // A contact sent using an old button must not skip the name step.
    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterContactMessage(),
      { fullName: 'Иванов Иван', tel: '+79001234567' });
    expect((await harness.services.sessions.find(actor.maxUserId, actor.maxUserId))?.type).toBe('WAITING_REQUESTER_NAME');
    expect(harness.messages.toUser(actor.maxUserId).at(-1)!.message.keyboard).toBeUndefined();
    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('Иванов Иван Иванович'));
    expect((await harness.services.sessions.find(actor.maxUserId, actor.maxUserId))?.type).toBe('WAITING_REQUESTER_PHONE');
    const phonePrompt = harness.messages.toUser(actor.maxUserId).at(-1)!.message;
    expect(phonePrompt.text).toContain('Шаг 2.');
    expect(phonePrompt.keyboard?.flat()).toContainEqual({ type: 'request_contact', text: '📱 Поделиться контактом' });

    await handleRequesterMessage(
      harness.services,
      actor,
      actor.maxUserId,
      requesterContactMessage(),
      { fullName: 'Иванов Иван', tel: '+79001234567' },
    );
    const session = await harness.services.sessions.find(actor.maxUserId, actor.maxUserId);
    expect(session?.type).toBe('WAITING_INCIDENT_SELECTION');
    expect(harness.services.sessions.readData(session!)).toMatchObject({
      requesterName: 'Иванов Иван Иванович',
      requesterPhone: '+7 900 123-45-67',
    });
  });

  it('does not accept a manually forwarded contact belonging to another MAX user', async () => {
    const actor = await actorFor(prisma, TEST_USERS.requesterA, 'Профиль MAX', []);
    if ((await harness.services.legal.status(actor.userId)).required) {
      const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
      await harness.services.legal.acceptUserAgreement(evidence);
      await harness.services.legal.acceptPersonalDataConsent(evidence);
    }
    await harness.services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId: actor.maxUserId,
      type: 'WAITING_REQUESTER_PHONE',
      data: { requesterName: 'Иванов Иван Иванович' },
    });

    await handleRequesterMessage(
      harness.services,
      actor,
      actor.maxUserId,
      requesterContactMessage(TEST_USERS.requesterB),
      { fullName: 'Петров Пётр', tel: '+79004445566' },
    );
    expect((await harness.services.sessions.find(actor.maxUserId, actor.maxUserId))?.type).toBe(
      'WAITING_REQUESTER_PHONE',
    );
  });

  it('changes only the selected draft fields and creates nothing before confirmation', async () => {
    vi.spyOn(harness.services.max, 'downloadFromUrl').mockResolvedValue({ body: Buffer.from('existing photo') });
    const actor = await actorFor(prisma, TEST_USERS.requesterA, 'Профиль MAX', []);
    if ((await harness.services.legal.status(actor.userId)).required) {
      const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
      await harness.services.legal.acceptUserAgreement(evidence);
      await harness.services.legal.acceptPersonalDataConsent(evidence);
    }
    const category = await prisma.category.findUniqueOrThrow({
      where: { code: CATEGORY_CODES.facility },
    });
    await harness.services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_CONFIRMATION',
      data: {
        requesterName: 'Иванов Иван',
        requesterPhone: '+7 900 111-22-33',
        selectedCategoryId: null,
        problemMunicipalityCode: 'BOROVSKY',
        problemMunicipalityName: 'Боровский округ',
        problemLocality: 'Боровск',
        draftText: 'Старый текст',
        draftMedia: [{ kind: 'IMAGE', token: 'old-photo-token', url: 'https://example.test/old-photo' }],
      },
    });

    const context = (callbackId: string) => ({
      services: harness.services,
      actor,
      chatId: actor.maxUserId,
      messageId: `message-${callbackId}`,
      callbackId,
    });

    await handleUserCallback(context('edit-name-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-name'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'name',
    });
    expect(harness.messages.toUser(actor.maxUserId).at(-1)!.message.keyboard).toBeUndefined();
    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('Петров Пётр'));

    await handleUserCallback(context('edit-phone-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-phone'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'phone',
    });
    expect(harness.messages.toUser(actor.maxUserId).at(-1)!.message.keyboard?.flat()).toContainEqual({ type: 'request_contact', text: '📱 Поделиться контактом' });
    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('8 999 000 11 22'));

    await handleUserCallback(context('edit-category-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-category'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'category',
    });
    await handleUserCallback(context('select-category'), {
      kind: 'user',
      action: 'category',
      argument: category.id,
    });

    await handleUserCallback(context('edit-location-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-location'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'location',
    });
    await handleUserCallback(context('select-location'), {
      kind: 'user',
      action: 'municipality',
      argument: `${category.id}~KALUGA_CITY`,
    });

    await handleUserCallback(context('edit-text-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-text'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'text',
    });
    await handleRequesterMessage(harness.services, actor, actor.maxUserId, requesterMessage('Новый текст'));

    await handleUserCallback(context('edit-photo-menu'), { kind: 'user', action: 'draft-edit' });
    await handleUserCallback(context('edit-photo'), {
      kind: 'user',
      action: 'draft-field',
      argument: 'photo',
    });
    await handleUserCallback(context('remove-photo'), {
      kind: 'user',
      action: 'draft-photo',
      argument: 'remove',
    });

    expect(await prisma.incident.count()).toBe(0);
    const preview = await harness.services.sessions.find(actor.maxUserId, actor.maxUserId);
    const draft = harness.services.sessions.readData(preview!);
    expect(preview?.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(draft).toMatchObject({
      requesterName: 'Петров Пётр',
      requesterPhone: '+7 999 000-11-22',
      selectedCategoryId: category.id,
      problemMunicipalityCode: 'KALUGA_CITY',
      problemMunicipalityName: 'Город Калуга',
      problemLocality: null,
      draftText: 'Новый текст',
      draftMedia: [],
    });

    await handleUserCallback(context('confirm-edited'), { kind: 'user', action: 'draft-confirm' });
    const incident = await prisma.incident.findFirstOrThrow({ include: { attachments: true } });
    expect(incident.requesterName).toBe('Петров Пётр');
    expect(incident.requesterPhone).toBe('+7 999 000-11-22');
    expect(incident.userSelectedCategoryId).toBe(category.id);
    expect(incident.problemMunicipalityCode).toBe('KALUGA_CITY');
    expect(incident.problemLocality).toBeNull();
    expect(incident.text).toBe('Новый текст');
    expect(incident.attachments).toHaveLength(0);
    const profile = await prisma.user.findUniqueOrThrow({ where: { maxUserId: actor.maxUserId } });
    expect(profile.requesterName).toBe('Петров Пётр');
    expect(profile.requesterPhone).toBe('+7 999 000-11-22');
  });

  // --- §11 daily limit -----------------------------------------------------

  it('enforces the published three-message limit under concurrent submissions', async () => {
    vi.spyOn(configModule, 'getConfig').mockReturnValue({ ...configModule.getConfig(), DAILY_INCIDENT_LIMIT: 3 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
      harness.services.incidents.create({ requester: requesterA(), text: `Проблема ${i}` }),
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RateLimitError);
    expect(await harness.services.incidents.remainingDailyQuota(TEST_USERS.requesterA)).toBe(0);
    expect(rulesText()).toContain('не более трех сообщений одного автора в сутки');
  });

  it('allows two incidents a day and refuses the third', async () => {
    const first = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Первое обращение',
    });
    const second = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Второе обращение',
    });

    expect(first.publicCode).toMatch(/^INC-\d{8}-0001$/);
    expect(second.publicCode).toMatch(/^INC-\d{8}-0002$/);

    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'Третье обращение' }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(await prisma.incident.count()).toBe(2);
  });

  it('does not consume the quota on a format error', async () => {
    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'я'.repeat(151) }),
    ).rejects.toThrow();
    await expect(
      harness.services.incidents.create({
        requester: requesterA(),
        text: 'Есть видео',
        media: [{ kind: 'VIDEO', url: 'https://example.test/v.mp4' }],
      }),
    ).rejects.toThrow();

    expect(await prisma.incident.count()).toBe(0);
    expect(await harness.services.incidents.remainingDailyQuota(TEST_USERS.requesterA)).toBe(2);
  });

  it('holds the limit under concurrent submissions', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        harness.services.incidents.create({ requester: requesterA(), text: `Параллельное ${index}` }),
      ),
    );

    const created = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(created).toHaveLength(2);
    expect(await prisma.incident.count()).toBe(2);

    const codes = await prisma.incident.findMany({ select: { publicCode: true } });
    expect(new Set(codes.map((row) => row.publicCode)).size).toBe(2);
  });

  it('does not let one user consume another user quota', async () => {
    await harness.services.incidents.create({ requester: requesterA(), text: 'A1' });
    await harness.services.incidents.create({ requester: requesterA(), text: 'A2' });
    const forB = await harness.services.incidents.create({ requester: requesterB(), text: 'B1' });
    expect(forB.requesterMaxUserId).toBe(TEST_USERS.requesterB);
  });

  it('refuses a banned user', async () => {
    await harness.services.bans.ban({ maxUserId: TEST_USERS.requesterA, reason: 'флуд' });
    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'Попытка' }),
    ).rejects.toThrow('временно недоступна');
    expect(await prisma.incident.count()).toBe(0);
  });

  // --- §13 SLA -------------------------------------------------------------

  it('sets the deadline to closing time of the third workday', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проверка срока',
    });
    expect(incident.deadlineAt).toEqual(incidentWorkday(incident.createdAt, 3).end);
  });

  it('stores the selected municipality and locality independently from the topic', async () => {
    const category = (await harness.services.categories.findByCode(CATEGORY_CODES.facility))!;
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проблема в Балабаново',
      userSelectedCategoryId: category.id,
      problemMunicipalityCode: 'BOROVSKY',
      problemMunicipalityName: 'Боровский округ',
      problemLocality: 'Балабаново',
    });

    expect(incident.userSelectedCategoryId).toBe(category.id);
    expect(incident.problemMunicipalityCode).toBe('BOROVSKY');
    expect(incident.problemMunicipalityName).toBe('Боровский округ');
    expect(incident.problemLocality).toBe('Балабаново');
  });

  // --- §17-§18 distribution ------------------------------------------------

  it('routes an incident to a sector and records who did it', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Не работает освещение возле входа.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    const category = await facility();

    const updated = await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    expect(updated.status).toBe(IncidentStatus.ASSIGNED);
    expect(updated.assignedGroupId).toBe(category.id);
    expect(updated.assignedByUserId).toBe(dispatcher.userId);
    expect(harness.messages.toChat(TEST_CHATS.sector).length).toBeGreaterThan(0);
  });

  it('closes the assignment picker after a group is selected', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Меню не должно остаться активным.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    const category = await facility();

    await handleIncidentCallback(
      {
        services: harness.services,
        actor: dispatcher,
        chatId: TEST_CHATS.distribution,
        messageId: 'assignment-picker-mid',
      },
      { kind: 'incident', action: 'assign-group', incidentId: incident.id, argument: category.id },
    );

    expect(harness.messages.deleted).not.toContain('assignment-picker-mid');
    const pending = (await harness.services.sessions.find(dispatcher.maxUserId, TEST_CHATS.distribution))!.data as any;
    await handleIncidentCallback({ services: harness.services, actor: dispatcher, chatId: TEST_CHATS.distribution },
      { kind: 'incident', action: 'action-confirm', incidentId: incident.id, argument: pending.confirmation.token });
    expect(harness.messages.deleted).toContain('assignment-picker-mid');
  });

  it('reuses the same picker message when a distribution branch is opened', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проверка перехода в список групп.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    await handleIncidentCallback(
      {
        services: harness.services,
        actor: dispatcher,
        chatId: TEST_CHATS.distribution,
        messageId: 'assignment-picker-mid',
      },
      { kind: 'incident', action: 'assign-branch', incidentId: incident.id, argument: 'local' },
    );

    expect(harness.messages.edits).toContainEqual({
      messageId: 'assignment-picker-mid',
      text: expect.stringContaining('🔴 НЕ РАСПРЕДЕЛЕНО'),
      mode: 'keyboard',
    });
  });

  it('lets only one of two simultaneous dispatchers win', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Гонка распределения',
    });
    const category = await facility();
    const first = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер 1', [UserRole.DISPATCHER]);
    const second = await actorFor(prisma, TEST_USERS.admin, 'Диспетчер 2', [UserRole.ADMIN]);

    const results = await Promise.allSettled([
      harness.services.distribution.assign(incident.id, category.id, first),
      harness.services.distribution.assign(incident.id, category.id, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    const assignedEvents = await prisma.incidentHistory.count({
      where: { incidentId: incident.id, action: HistoryAction.ASSIGNED },
    });
    expect(assignedEvents).toBe(1);
  });

  it('refuses a repeated distribution callback', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Повторное нажатие',
    });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    await expect(
      harness.services.distribution.assign(incident.id, category.id, dispatcher),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects an incident with a reason and tells the author', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Не по теме',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    const rejected = await harness.services.distribution.reject(incident.id, 'Не относится к работе', dispatcher);

    expect(rejected.status).toBe(IncidentStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('Не относится к работе');
    const toRequester = harness.messages.toUser(TEST_USERS.requesterA);
    expect(toRequester.at(-1)!.message.text).toContain('отклонено');
    // §11: a rejected incident still counts against the daily limit.
    expect(await harness.services.incidents.remainingDailyQuota(TEST_USERS.requesterA)).toBe(1);
  });

  it('cannot reject an incident that was already routed', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Тест' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    await expect(
      harness.services.distribution.reject(incident.id, 'Передумал', dispatcher),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // --- §22-§24 work and answers -------------------------------------------

  it('claims an incident for one responder only', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'В работу' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    const responder = await actorFor(prisma, TEST_USERS.responder, 'Пётр Петров', [UserRole.RESPONDER]);
    const taken = await harness.services.sector.takeInWork(incident.id, responder);
    expect(taken.status).toBe(IncidentStatus.IN_PROGRESS);
    expect(taken.currentResponderId).toBe(responder.userId);

    await expect(harness.services.sector.takeInWork(incident.id, responder)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('creates answer versions and refuses video attachments', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Ответ' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Ответственный', [UserRole.RESPONDER]);

    await expect(
      harness.services.answers.submit(incident.id, responder, 'С видео', [
        { kind: 'VIDEO', url: 'https://example.test/v.mp4' },
      ]),
    ).rejects.toThrow('Видео');

    const { answer } = await harness.services.answers.submit(incident.id, responder, 'Освещение восстановлено.');
    expect(answer.version).toBe(1);
    expect(answer.status).toBe(AnswerStatus.WAITING_REVIEW);

    const fresh = await harness.services.repository.findById(incident.id);
    expect(fresh!.status).toBe(IncidentStatus.WAITING_REVIEW);
    expect(harness.messages.toChat(TEST_CHATS.review).length).toBeGreaterThan(0);
    // The handler sends one visible confirmation. The answer service must not
    // add a second copy to the same sector chat.
    expect(harness.messages.toChat(TEST_CHATS.sector)).toHaveLength(1);
  });

  it('lets only one of two concurrent answer submissions through', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Гонка ответов' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    const one = await actorFor(prisma, TEST_USERS.responder, 'Ответственный 1', [UserRole.RESPONDER]);
    const two = await actorFor(prisma, TEST_USERS.admin, 'Ответственный 2', [UserRole.ADMIN]);

    const results = await Promise.allSettled([
      harness.services.answers.submit(incident.id, one, 'Вариант 1'),
      harness.services.answers.submit(incident.id, two, 'Вариант 2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.incidentAnswer.count({ where: { incidentId: incident.id } })).toBe(1);
  });
});
