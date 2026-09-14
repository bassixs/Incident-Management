import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, actorFor, GROUP_CODES, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { pendingConfirmation, cancelStaffSession } from '../../src/bot/callbacks/staff-confirmation';
import * as outbox from '../../src/delivery/workflow-outbox';
import { invitePersonalWork, enterPersonalWork, personalAction } from '../../src/work-queues/private-workspace';

describeIntegration('staff action confirmations', () => {
  let prisma: PrismaClient, h: TestHarness, actor: Awaited<ReturnType<typeof actorFor>>, other: typeof actor;
  let id: string;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Иванов Иван Иванович', [UserRole.ADMIN]);
    other = await actorFor(prisma, 9977n, 'Петров Пётр', [UserRole.ADMIN]);
    id = (await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Алексей Иванов', phone: '+79001234567' }, text: 'Не работает фонарь' })).id;
  });
  const fresh = () => h.services.repository.findById(id);
  const session = (chat: bigint) => h.services.sessions.find(actor.maxUserId, chat);
  const token = async (chat: bigint) => pendingConfirmation((await session(chat))!)!.token;
  async function click(chat: bigint, action: string, argument?: string, who = actor) {
    const p = parseCallbackPayload(`incident:${action}:${id}${argument ? ':' + argument : ''}`);
    if (p?.kind !== 'incident') throw Error('bad payload');
    return handleIncidentCallback({ services: h.services, actor: who, chatId: chat, messageId: 'preview' }, p);
  }
  async function input(chat: bigint, text: string) {
    await handleOperatorMessage(h.services, actor, chat, { body: { mid: randomUUID(), text, attachments: [] } } as never, (await session(chat))!);
  }
  async function assigned(direct = false) {
    const group = await h.services.responsibleGroups.findByCode(direct ? GROUP_CODES.regional : GROUP_CODES.facility);
    await h.services.distribution.assign(id, group!.id, actor); return direct ? TEST_CHATS.regional : TEST_CHATS.sector;
  }
  async function reviewing() { await assigned(); return (await h.services.answers.submit(id, actor, 'Фонарь восстановлен.')).answer.id; }

  it('approval waits, cancels, rejects a stale button, then approves once', async () => {
    const answerId = await reviewing(); await click(TEST_CHATS.review, 'approve', answerId);
    expect((await fresh())!.status).toBe('WAITING_REVIEW');
    expect(h.messages.toUser(TEST_USERS.requesterA).some(m => m.message.text.includes('Фонарь восстановлен'))).toBe(false);
    const old = await token(TEST_CHATS.review); await click(TEST_CHATS.review, 'action-cancel', old);
    await expect(click(TEST_CHATS.review, 'action-confirm', old)).rejects.toThrow(/устарело/);
    await click(TEST_CHATS.review, 'approve', answerId); const current = await token(TEST_CHATS.review);
    await click(TEST_CHATS.review, 'action-confirm', current);
    expect((await fresh())!.status).toBe('RESOLVED');
    await expect(click(TEST_CHATS.review, 'action-confirm', current)).rejects.toThrow();
  });

  it('previews revision remarks, edits them and sends only the confirmed text', async () => {
    const answerId = await reviewing(), deadline = (await fresh())!.deadlineAt;
    await click(TEST_CHATS.review, 'revision', answerId); await input(TEST_CHATS.review, 'Уточните дату.');
    expect((await fresh())!.status).toBe('WAITING_REVIEW'); const old = await token(TEST_CHATS.review);
    await input(TEST_CHATS.review, 'Случайное сообщение'); expect(await token(TEST_CHATS.review)).toBe(old);
    await click(TEST_CHATS.review, 'action-edit', old); await input(TEST_CHATS.review, 'Уточните адрес.');
    await expect(click(TEST_CHATS.review, 'action-confirm', old)).rejects.toThrow();
    await click(TEST_CHATS.review, 'action-confirm', await token(TEST_CHATS.review));
    expect((await fresh())!).toMatchObject({ status: 'REVISION_REQUIRED', revisionReason: 'Уточните адрес.', deadlineAt: deadline });
  });

  it.each([false, true])('previews an answer before sending, direct=%s', async direct => {
    const chat = await assigned(direct); await click(chat, 'answer'); await input(chat, 'Работы выполнены.');
    expect((await fresh())!.answers).toHaveLength(0);
    await click(chat, 'action-confirm', await token(chat));
    expect((await fresh())!.answers).toHaveLength(1);
    expect((await fresh())!.status).toBe(direct ? 'RESOLVED' : 'WAITING_REVIEW');
  });

  it('cancels redistribution, then returns it only with confirmed reason', async () => {
    const chat = await assigned(); await click(chat, 'redistribute'); await input(chat, 'Другая организация.');
    const before = (await fresh())!; await click(chat, 'action-cancel', await token(chat));
    expect((await fresh())!.status).toBe(before.status);
    await click(chat, 'redistribute'); await input(chat, 'Обслуживает другая организация.');
    await click(chat, 'action-confirm', await token(chat));
    expect((await fresh())!).toMatchObject({ status: 'DISTRIBUTION', deadlineAt: before.deadlineAt });
  });

  it('confirms assignment and preserves the incident on cancel', async () => {
    const group = (await h.services.responsibleGroups.findByCode(GROUP_CODES.facility))!;
    await click(TEST_CHATS.distribution, 'assign-group', group.id);
    expect((await fresh())!.assignedGroupId).toBeNull();
    const pending = await token(TEST_CHATS.distribution);
    await input(TEST_CHATS.distribution, 'Случайное сообщение');
    expect(await token(TEST_CHATS.distribution)).toBe(pending);
    expect(h.messages.toChat(TEST_CHATS.distribution).at(-1)!.message.text).toContain('ждёт подтверждения');
    await click(TEST_CHATS.distribution, 'action-cancel', await token(TEST_CHATS.distribution));
    await click(TEST_CHATS.distribution, 'assign-group', group.id);
    await click(TEST_CHATS.distribution, 'action-confirm', await token(TEST_CHATS.distribution));
    expect((await fresh())!.assignedGroupId).toBe(group.id);
  });

  it('requires confirmation for blocking a resident', async () => {
    await click(TEST_CHATS.distribution, 'ban'); await input(TEST_CHATS.distribution, 'Спам.');
    expect(await prisma.ban.count()).toBe(0);
    await click(TEST_CHATS.distribution, 'action-cancel', await token(TEST_CHATS.distribution));
    expect(await prisma.ban.count()).toBe(0);
    await click(TEST_CHATS.distribution, 'ban'); await input(TEST_CHATS.distribution, 'Повторный спам.');
    await click(TEST_CHATS.distribution, 'action-confirm', await token(TEST_CHATS.distribution));
    expect(await prisma.ban.count()).toBe(1);
  });

  it('rejects a foreign employee, wrong chat and an expired review reservation', async () => {
    const answer = await reviewing(); await click(TEST_CHATS.review, 'approve', answer); const t = await token(TEST_CHATS.review);
    await expect(click(TEST_CHATS.review, 'action-confirm', t, other)).rejects.toThrow();
    await expect(click(TEST_CHATS.sector, 'action-confirm', t)).rejects.toThrow();
    await prisma.actionLock.update({ where: { key: `review-queue:${id}` }, data: { lockedUntil: new Date(0) } });
    await expect(click(TEST_CHATS.review, 'action-confirm', t)).rejects.toThrow();
    expect((await fresh())!.status).toBe('WAITING_REVIEW');
  });

  it('retains a preview after transactional failure and permits retry', async () => {
    const answer = await reviewing(); await click(TEST_CHATS.review, 'approve', answer); const t = await token(TEST_CHATS.review);
    vi.spyOn(outbox, 'queueAnswer').mockRejectedValueOnce(new Error('queue failed'));
    await expect(click(TEST_CHATS.review, 'action-confirm', t)).rejects.toThrow('queue failed');
    expect(await token(TEST_CHATS.review)).toBe(t); expect((await fresh())!.status).toBe('WAITING_REVIEW');
    await click(TEST_CHATS.review, 'action-confirm', t); expect((await fresh())!.status).toBe('RESOLVED');
  });

  it('serializes cancellation against confirmation and never reports a successful cancellation during send', async () => {
    const answer = await reviewing(); await click(TEST_CHATS.review, 'approve', answer);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
    const approve = h.services.review.approve.bind(h.services.review);
    vi.spyOn(h.services.review, 'approve').mockImplementationOnce(async (...args) => { entered(); await gate; return approve(...args); });
    const sending = click(TEST_CHATS.review, 'action-confirm', await token(TEST_CHATS.review)); await start;
    await expect(cancelStaffSession(h.services, actor.maxUserId, TEST_CHATS.review)).rejects.toThrow(/выполняется/);
    release(); await sending; expect((await fresh())!.status).toBe('RESOLVED');
  });

  it('retains media tokens in the preview and ingests attachments only after confirmation', async () => {
    const chat = await assigned(); await click(chat, 'answer');
    const ingest = vi.spyOn(h.services.media, 'ingestAll');
    await handleOperatorMessage(h.services, actor, chat, { body: { mid: randomUUID(), text: 'Фото результата.',
      attachments: [{ type: 'image', payload: { token: 'confirmed-photo' } }, { type: 'file', filename: 'Акт.pdf', payload: { token: 'confirmed-file', url: 'https://example.test/file' } }] } } as never, (await session(chat))!);
    expect(ingest).not.toHaveBeenCalled();
    await click(chat, 'action-confirm', await token(chat));
    expect(ingest.mock.calls[0]![1]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'IMAGE', token: 'confirmed-photo' }), expect.objectContaining({ kind: 'FILE', token: 'confirmed-file' })]));
  });

  it('continues a group confirmation privately without requesting a second confirmation', async () => {
    const answer = await reviewing(); await click(TEST_CHATS.review, 'approve', answer);
    h.services.max = { api: { getMyInfo: async () => ({ username: 'test_bot' }), getChatMembers: async () => ({ members: [{ user_id: Number(actor.maxUserId), is_bot: false }] }) } } as never;
    await invitePersonalWork(h.services, actor, TEST_CHATS.review, id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: id } });
    await enterPersonalWork(h.services, actor, item.id);
    const t = await token(TEST_CHATS.review);
    await expect(click(TEST_CHATS.review, 'action-confirm', t)).rejects.toThrow(/личном/);
    await personalAction(h.services, actor, item.id, 'run', `incident:action-confirm:${id}:${t}`);
    expect((await fresh())!.status).toBe('RESOLVED');
  });
});
