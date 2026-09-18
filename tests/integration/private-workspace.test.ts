import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient, type PrivateWorkItem } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, actorFor, GROUP_CODES, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { enterPersonalWork, invitePersonalWork, personalAction, receivePersonalText, personalHome, exitPersonalWork, sweepPersonalWork, withPersonalWorkLock } from '../../src/work-queues/private-workspace';
import { handleMessageUpdate, handleBotStarted } from '../../src/bot/handlers/message.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import type { Message } from '../../src/max/max-types';
import { buildServices } from '../../src/app/container';
import * as outbox from '../../src/delivery/workflow-outbox';
import { hasPrivateWorkAccess } from '../../src/users/private-work-access';
import { sendMainMenu } from '../../src/bot/handlers/requester.handler';

describeIntegration('private employee workspace', () => {
  let prisma: PrismaClient, h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>, other: typeof actor;
  let allowed: boolean;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Иванов Иван Иванович', [UserRole.ADMIN]);
    other = await actorFor(prisma, 9911n, 'Петров Пётр Петрович', [UserRole.ADMIN]); allowed = true;
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: {
      getMyInfo: vi.fn(async () => ({ username: 'test_bot' })),
      getChatMembers: vi.fn(async (_chat, args) => ({ members: allowed ? args.user_ids.map((id: number) => ({ user_id: id, is_bot: false })) : [] })),
    } } as never;
  });
  const create = () => h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Алексей', phone: '+79001234567' }, text: 'Не работает освещение во дворе' });
  const input = (text: string, attachments: Message['body']['attachments'] = []) => ({ body: { mid: randomUUID(), text, attachments } } as Message);
  const fresh = (item: PrivateWorkItem) => prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } });
  const data = async (item: PrivateWorkItem) => (await fresh(item)).data as any;
  async function open(kind: 'distribution' | 'sector' | 'review' = 'sector') {
    const incident = await create();
    if (kind !== 'distribution') {
      const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
      await h.services.distribution.assign(incident.id, group.id, actor);
      if (kind === 'review') await h.services.answers.submit(incident.id, actor, 'Освещение восстановлено.', []);
    }
    const chat = kind === 'distribution' ? TEST_CHATS.distribution : kind === 'review' ? TEST_CHATS.review : TEST_CHATS.sector;
    await invitePersonalWork(h.services, actor, chat, incident.id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id, maxUserId: actor.maxUserId } });
    await enterPersonalWork(h.services, actor, item.id);
    return { incident, item, chat };
  }
  const run = (item: PrivateWorkItem, action: string, argument?: string) => personalAction(h.services, actor, item.id, 'run', `incident:${action}:${item.incidentId}${argument ? ':' + argument : ''}`);
  const confirm = async (item: PrivateWorkItem) => personalAction(h.services, actor, item.id, 'confirm', (await data(item)).draft?.nonce ?? (await data(item)).pending?.nonce);

  it.each(['command', 'link', 'button'])('denies a resident the home panel via %s before creating work items', async entry => {
    actor = await actorFor(prisma, 9912n, 'Житель', [UserRole.REQUESTER]); allowed = false;
    const person = { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false };
    const message = { sender: person, recipient: { chat_id: 123456, chat_type: 'dialog' }, body: { mid: randomUUID(), text: '/work' } };
    if (entry === 'command') await handleMessageUpdate(h.services, { update: { message } } as never);
    if (entry === 'link') await handleBotStarted(h.services, { user: person, update: { payload: 'staff_home' } } as never);
    if (entry === 'button') await handleCallbackUpdate(h.services, { update: { message, callback: { callback_id: randomUUID(), user: person, payload: 'personal:home' } } } as never);
    const replies = h.messages.toUser(actor.maxUserId);
    expect(replies.some(m => m.message.text.includes('только участникам рабочих чатов'))).toBe(true);
    expect(replies.some(m => m.message.text.includes('МОЯ РАБОТА'))).toBe(false);
    expect(replies.flatMap(m => m.message.keyboard?.flat() ?? []).some(b => b.type === 'callback' && b.payload.startsWith('personal:'))).toBe(false);
    expect(await prisma.privateWorkItem.count()).toBe(0);
  });

  it.each([TEST_CHATS.distribution, TEST_CHATS.review, TEST_CHATS.sector, -1005n])('allows a current member of chat %s without prior work or staff roles', async chat => {
    actor = await actorFor(prisma, 9912n, 'Новый сотрудник', [UserRole.REQUESTER]);
    vi.mocked(h.services.max.api.getChatMembers).mockImplementation(async id => ({ members: BigInt(id) === chat ? [{ user_id: Number(actor.maxUserId), is_bot: false }] : [] }) as never);
    await personalHome(h.services, actor);
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('МОЯ РАБОТА');
  });

  it('removes access and the menu button immediately after leaving, despite admin role and saved drafts', async () => {
    const { item } = await open(); await run(item, 'answer'); await receivePersonalText(h.services, actor, input('Черновик'));
    allowed = false;
    await sendMainMenu(h.services, actor);
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.keyboard?.flat().some(b => b.text === 'Моя работа')).toBe(false);
    await personalHome(h.services, actor);
    expect((await fresh(item)).selected).toBe(false); expect((await data(item)).draft.text).toBe('Черновик');
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).not.toContain('МОЯ РАБОТА');
    await expect(invitePersonalWork(h.services, actor, TEST_CHATS.sector)).rejects.toThrow('участник');
  });

  it('fails closed on MAX outage and does not treat a different returned member as the caller', async () => {
    vi.mocked(h.services.max.api.getChatMembers).mockRejectedValue(new Error('MAX unavailable'));
    expect(await hasPrivateWorkAccess(h.services, actor.maxUserId)).toBe(false);
    vi.mocked(h.services.max.api.getChatMembers).mockResolvedValue({ members: [{ user_id: Number(other.maxUserId), is_bot: false }] } as never);
    expect(await hasPrivateWorkAccess(h.services, actor.maxUserId)).toBe(false);
  });

  it('ignores old work records for disabled chats', async () => {
    const { item } = await open();
    await prisma.responsibleGroup.updateMany({ where: { maxChatId: item.originChatId }, data: { isActive: false } });
    vi.mocked(h.services.max.api.getChatMembers).mockImplementation(async id => ({ members: BigInt(id) === item.originChatId ? [{ user_id: Number(actor.maxUserId), is_bot: false }] : [] }) as never);
    expect(await hasPrivateWorkAccess(h.services, actor.maxUserId)).toBe(false);
  });

  it('opens a scoped link and shows identity, incident, reservation and explicit input state privately', async () => {
    const { incident, item, chat } = await open();
    const invitation = h.messages.toChat(chat).find(m => m.message.keyboard?.flat().some(b => b.type === 'link' && b.url.includes('staff_')))!;
    expect(invitation.message.text).toContain(actor.displayName);
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('Бот пока не ждёт текст');
    const count = h.messages.toChat(chat).length;
    await run(item, 'answer');
    const prompt = h.messages.toUser(actor.maxUserId).at(-1)!.message;
    expect(prompt.text).toContain(incident.publicCode); expect(prompt.text).toContain('Следующим сообщением');
    expect(h.messages.toChat(chat)).toHaveLength(count);
    expect((await h.services.sessions.find(actor.maxUserId, chat))!.data).toMatchObject({ privateWorkspaceId: item.id });
    await personalAction(h.services, actor, item.id, 'details');
    const details = h.messages.toUser(actor.maxUserId).at(-1)!.message.text;
    expect(details).toContain(incident.publicCode);
    expect(details).not.toMatch(/Срок ответа|ПРОСРОЧЕНО|срок приостановлен/);
    for (const entry of h.messages.toUser(actor.maxUserId)) for (const b of entry.message.keyboard?.flat() ?? []) if (b.type === 'callback') expect(parseCallbackPayload(b.payload)).not.toBeNull();
  });

  it('previews answer and attachments, supports edit, then submits once to the correct incident', async () => {
    const { incident, item } = await open(); await run(item, 'answer');
    const ingest = vi.spyOn(h.services.media, 'ingestAll').mockResolvedValueOnce([{ type: 'IMAGE', storageKey: 'answers/private.jpg', size: 3 }]);
    await receivePersonalText(h.services, actor, input('Первый текст', [{ type: 'image', payload: { url: 'https://example.test/photo', token: 'photo', photo_id: 1 } }]));
    const oldNonce = (await data(item)).draft.nonce;
    expect(await prisma.incidentAnswer.count()).toBe(0);
    await personalAction(h.services, actor, item.id, 'back');
    await expect(personalAction(h.services, actor, item.id, 'confirm', oldNonce)).rejects.toThrow('устарел');
    await receivePersonalText(h.services, actor, input('Исправленный ответ', [{ type: 'image', payload: { url: 'https://example.test/photo', token: 'photo', photo_id: 1 } }]));
    const token = (await data(item)).draft.nonce;
    await confirm(item);
    expect(ingest.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ kind: 'IMAGE' })]);
    const answer = await prisma.incidentAnswer.findFirstOrThrow({ include: { attachments: true } });
    expect(answer.incidentId).toBe(incident.id); expect(answer.text).toBe('Исправленный ответ'); expect(answer.attachments).toHaveLength(1);
    await expect(personalAction(h.services, actor, item.id, 'confirm', token)).rejects.toThrow(); expect(await prisma.incidentAnswer.count()).toBe(1);
  });

  it('preserves the draft through expiry and a service restart, but requires a fresh claim', async () => {
    const { incident, item } = await open(); await run(item, 'answer'); await receivePersonalText(h.services, actor, input('Сохранённый ответ'));
    await prisma.actionLock.update({ where: { key: `sector-queue:${incident.id}` }, data: { lockedUntil: new Date(Date.now() - 1) } });
    await h.services.workQueues.sweep();
    await expect(confirm(item)).rejects.toThrow('Закрепление'); expect((await data(item)).draft.text).toBe('Сохранённый ответ');
    const restarted = buildServices(prisma, { messages: h.messages as never, media: h.services.media }); restarted.max = h.services.max; h.services = restarted;
    await personalAction(h.services, actor, item.id, 'resume'); await confirm(item);
    expect((await prisma.incidentAnswer.findFirstOrThrow()).text).toBe('Сохранённый ответ');
  });

  it('releases work while preserving its draft, and prevents use while a colleague owns it', async () => {
    const { incident, item } = await open(); await run(item, 'answer'); await receivePersonalText(h.services, actor, input('Черновик'));
    await personalAction(h.services, actor, item.id, 'release');
    expect((await data(item)).draft.text).toBe('Черновик');
    await h.services.sector.takeInWork(incident.id, other);
    await expect(personalAction(h.services, actor, item.id, 'resume')).rejects.toThrow(); await expect(confirm(item)).rejects.toThrow();
    expect(await prisma.incidentAnswer.count()).toBe(0);
  });

  it('handles assignment and review approval with private confirmation', async () => {
    const { incident, item, chat } = await open('distribution');
    await run(item, 'assign');
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await run(item, 'assign-group', group.id);
    expect((await h.services.repository.findById(incident.id))!.status).toBe('DISTRIBUTION');
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain(group.name);
    await confirm(item); expect((await h.services.repository.findById(incident.id))!.status).toBe('ASSIGNED');
    expect(h.messages.toChat(chat).some(m => m.message.text.includes('Подтвердить'))).toBe(false);
    await h.services.answers.submit(incident.id, actor, 'Ответ', []);
    await invitePersonalWork(h.services, actor, TEST_CHATS.review, incident.id);
    const review = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id, originChatId: TEST_CHATS.review } });
    await enterPersonalWork(h.services, actor, review.id);
    const answer = await prisma.incidentAnswer.findFirstOrThrow(); await run(review, 'approve', answer.id);
    expect((await h.services.repository.findById(incident.id))!.status).toBe('WAITING_REVIEW');
    await confirm(review); expect((await h.services.repository.findById(incident.id))!.status).toBe('RESOLVED');
  });

  it('previews review remarks and redistribution reasons before applying them', async () => {
    const { incident, item } = await open('review'); const answer = await prisma.incidentAnswer.findFirstOrThrow();
    await run(item, 'revision', answer.id); await receivePersonalText(h.services, actor, input('Уточните сроки'));
    expect((await h.services.repository.findById(incident.id))!.status).toBe('WAITING_REVIEW');
    await confirm(item); expect((await h.services.repository.findById(incident.id))!.status).toBe('REVISION_REQUIRED');
    await invitePersonalWork(h.services, actor, TEST_CHATS.sector, incident.id);
    const sector = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id, originChatId: TEST_CHATS.sector } });
    await enterPersonalWork(h.services, actor, sector.id); await run(sector, 'redistribute');
    await receivePersonalText(h.services, actor, input('Другая организация'));
    await confirm(sector); expect((await h.services.repository.findById(incident.id))!.status).toBe('DISTRIBUTION');
  });

  it('keeps rejection choices, editing and confirmation in the private dialogue', async () => {
    const { incident, item, chat } = await open('distribution'); const count = h.messages.toChat(chat).length;
    await run(item, 'reject');
    const current = () => h.services.sessions.find(actor.maxUserId, chat);
    await run(item, 'reject-reason', `${((await current())!.data as any).rejectionToken}.other`);
    await receivePersonalText(h.services, actor, input('Собственная причина'));
    expect((await h.services.repository.findById(incident.id))!.status).toBe('DISTRIBUTION');
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('Проверьте сообщение');
    expect(h.messages.toChat(chat)).toHaveLength(count);
    await run(item, 'reject-confirm', ((await current())!.data as any).rejectionToken);
    expect((await h.services.repository.findById(incident.id))!.status).toBe('REJECTED');
  });

  it('rejects forwarded links/buttons, revoked membership, API failure and another incident payload', async () => {
    const { item } = await open();
    await expect(enterPersonalWork(h.services, other, item.id)).rejects.toThrow('другого сотрудника');
    await expect(personalAction(h.services, actor, item.id, 'run', `incident:answer:${randomUUID()}`)).rejects.toThrow();
    allowed = false; const before = h.messages.toUser(actor.maxUserId).length;
    await expect(personalAction(h.services, actor, item.id, 'details')).rejects.toThrow('участник');
    expect(h.messages.toUser(actor.maxUserId)).toHaveLength(before);
    await personalHome(h.services, actor); expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).not.toContain('INC-');
    allowed = true; vi.mocked(h.services.max.api.getChatMembers).mockRejectedValueOnce(new Error('MAX unavailable'));
    await expect(personalAction(h.services, actor, item.id, 'details')).rejects.toThrow('MAX unavailable');
  });

  it('does not consume group text after moving input to the personal dialogue', async () => {
    const { item, chat } = await open(); await run(item, 'answer');
    await handleMessageUpdate(h.services, { update: { update_type: 'message_created', message: { sender: { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false }, recipient: { chat_id: Number(chat), chat_type: 'chat' }, body: { mid: randomUUID(), text: 'Случайный текст в группе' } } } } as never);
    expect(await prisma.incidentAnswer.count()).toBe(0); expect((await data(item)).draft).toBeUndefined();
    expect(h.messages.toChat(chat).at(-1)!.message.text).toContain('Ответ здесь не отправлен');
  });

  it('permits a verified ordinary chat member and preserves rejection input after expiry', async () => {
    const { item, incident, chat } = await open('distribution');
    actor = { ...actor, roles: [UserRole.REQUESTER], role: UserRole.REQUESTER };
    await run(item, 'reject');
    const session = await h.services.sessions.find(actor.maxUserId, chat);
    await run(item, 'reject-reason', `${(session!.data as any).rejectionToken}.other`);
    await prisma.incident.update({ where: { id: incident.id }, data: { distributionClaimUntil: new Date(Date.now() - 1) } });
    await h.services.distributionQueue.sweep();
    await receivePersonalText(h.services, actor, input('Сохранённая причина'));
    expect((await data(item)).session.data.reason).toBe('Сохранённая причина');
    await personalAction(h.services, actor, item.id, 'resume');
    await run(item, 'reject-confirm', (await data(item)).session.data.rejectionToken);
    expect((await h.services.repository.findById(incident.id))!.status).toBe('REJECTED');
  });

  it('keeps a saved draft after queue failure and warns only once near expiry', async () => {
    const { item, incident } = await open(); await run(item, 'answer'); await receivePersonalText(h.services, actor, input('Черновик'));
    vi.spyOn(outbox, 'queueAnswer').mockRejectedValueOnce(new Error('queue down')); await expect(confirm(item)).rejects.toThrow('queue down');
    expect((await data(item)).draft.text).toBe('Черновик'); expect(await prisma.incidentAnswer.count()).toBe(0);
    await prisma.actionLock.update({ where: { key: `sector-queue:${incident.id}` }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    await sweepPersonalWork(h.services); await sweepPersonalWork(h.services);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: { startsWith: `private-warning:${item.id}:` } } })).toBe(1);
  });

  it('separates resident mode and serializes private operations for one employee', async () => {
    const { item } = await open(); await run(item, 'answer'); await receivePersonalText(h.services, actor, input('Черновик сотрудника'));
    await exitPersonalWork(h.services, actor.maxUserId);
    expect(await receivePersonalText(h.services, actor, input('Обращение жителя'))).toBe(false);
    expect((await data(item)).draft.text).toBe('Черновик сотрудника');
    await withPersonalWorkLock(h.services, actor.maxUserId, async () => { await expect(withPersonalWorkLock(h.services, actor.maxUserId, async () => undefined)).rejects.toThrow('ещё выполняется'); });
  });

  it('restores context through bot_started and real callbacks/messages in a dialogue with a different chat id', async () => {
    const { item } = await open(); await exitPersonalWork(h.services, actor.maxUserId);
    const person = { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false };
    await handleBotStarted(h.services, { user: person, update: { payload: `staff_${item.id}` } } as never);
    const recipient = { chat_id: 87654321, chat_type: 'dialog' };
    await handleCallbackUpdate(h.services, { update: { callback: { callback_id: randomUUID(), user: person, payload: `personal:run:${item.id}:incident:answer:${item.incidentId}` }, message: { recipient, body: { mid: randomUUID() } } } } as never);
    const ingest = vi.spyOn(h.services.media, 'ingestAll').mockResolvedValueOnce([{ type: 'FILE', storageKey: 'answers/official.pdf', size: 3 }]);
    await handleMessageUpdate(h.services, { update: { message: { sender: person, recipient, body: { mid: randomUUID(), text: 'Личный ответ', attachments: [{ type: 'file', filename: 'official.pdf', payload: { url: 'https://example.test/official.pdf', token: 'document' } }] } } } } as never);
    expect((await data(item)).draft.text).toBe('Личный ответ'); expect(await prisma.incidentAnswer.count()).toBe(0);
    await handleCallbackUpdate(h.services, { update: { callback: { callback_id: randomUUID(), user: person, payload: `personal:confirm:${item.id}:${(await data(item)).draft.nonce}` }, message: { recipient, body: { mid: randomUUID() } } } } as never);
    expect((await prisma.incidentAnswer.findFirstOrThrow()).text).toBe('Личный ответ');
    expect(ingest.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ kind: 'FILE' })]);
  });
});
