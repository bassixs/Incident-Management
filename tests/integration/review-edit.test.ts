import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, actorFor, GROUP_CODES, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { enterPersonalWork, invitePersonalWork, personalAction, receivePersonalText, showPersonalWork } from '../../src/work-queues/private-workspace';
import { reviewEditDraft } from '../../src/review/review-edit';
import * as outbox from '../../src/delivery/workflow-outbox';
import type { Message } from '../../src/max/max-types';
import { MaxMessageService } from '../../src/max/max-message.service';

describeIntegration('reviewer corrections', () => {
  let prisma: PrismaClient, h: TestHarness;
  let reviewer: Awaited<ReturnType<typeof actorFor>>, executor: typeof reviewer;
  let id: string, originalId: string;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    reviewer = await actorFor(prisma, TEST_USERS.approver, 'Петров Пётр Петрович', [UserRole.APPROVER]);
    executor = await actorFor(prisma, TEST_USERS.admin, 'Иванов Иван Иванович', [UserRole.ADMIN]);
    const incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Алексей Иванов', phone: '+79001234567' }, text: 'Не работает освещение' }); id = incident.id;
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await h.services.distribution.assign(id, group.id, executor);
    originalId = (await h.services.answers.submit(id, executor, 'Здравствуйте освещение восстановлено.', [])).answer.id;
    h.services.max = { api: { getMyInfo: vi.fn(async () => ({ username: 'test_bot' })),
      getChatMembers: vi.fn(async (_id, args) => ({ members: args.user_ids.map((user_id: number) => ({ user_id, is_bot: false })) })) } } as never;
  });
  const fresh = () => h.services.repository.findById(id);
  const session = () => h.services.sessions.find(reviewer.maxUserId, TEST_CHATS.review);
  const message = (text: string, attachments: Message['body']['attachments'] = []) => ({ body: { mid: randomUUID(), text, attachments } } as Message);
  async function click(action: string, argument?: string, actor = reviewer, chatId = TEST_CHATS.review) {
    const payload = parseCallbackPayload(`incident:${action}:${id}${argument ? ':' + argument : ''}`);
    if (!payload || payload.kind !== 'incident') throw Error('invalid callback');
    const result = await handleIncidentCallback({ services: h.services, actor, chatId }, payload);
    if (action === 'approve') {
      const pending = (await h.services.sessions.find(actor.maxUserId, chatId))?.data as any;
      if (pending?.confirmation) await click('action-confirm', pending.confirmation.token, actor, chatId);
    }
    return result;
  }
  async function type(text = 'Здравствуйте, освещение восстановлено.') {
    await handleOperatorMessage(h.services, reviewer, TEST_CHATS.review, message(text), (await session())!);
  }
  async function preview() { await click('review-edit', originalId); await type(); return (await session())!; }
  const token = async () => reviewEditDraft((await session())!).editToken;

  it('shows reviewer edits and the matching return reason in repeated review and personal details', async () => {
    await preview(); await click('review-edit-save', await token());
    await h.services.review.requestRevision(id, 'Укажите дату ремонта.', reviewer);
    await h.services.answers.submit(id, executor, 'Светильник заменён 14 сентября.', []);
    const checkHistory = (text: string) => {
      expect(text).toContain('Первоначальный ответ (версия 1):\nЗдравствуйте освещение восстановлено.');
      expect(text).toContain('Предыдущий ответ (версия 2):\nЗдравствуйте, освещение восстановлено.');
      expect(text).not.toContain('Причина доработки версии 1:');
      expect(text).toContain('Причина доработки версии 2:\nУкажите дату ремонта.');
      expect(text).toContain('НОВЫЙ ОТВЕТ (версия 3):\nСветильник заменён 14 сентября.');
    };
    checkHistory(h.messages.toChat(TEST_CHATS.review).at(-1)!.message.text);
    await invitePersonalWork(h.services, reviewer, TEST_CHATS.review, id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: id } });
    await enterPersonalWork(h.services, reviewer, item.id);
    await showPersonalWork(h.services, reviewer, item.id, true);
    checkHistory(h.messages.toUser(reviewer.maxUserId).at(-1)!.message.text);
  });

  it('previews, saves a new version and only then approves; preserves attachments, executor, history and срок ответа', async () => {
    await prisma.answerAttachment.create({ data: { answerId: originalId, type: 'FILE', storageKey: 'review-correction.pdf', mimeType: 'application/pdf', originalName: 'Акт.pdf', size: 50, maxToken: 'file-token' } });
    const before = (await fresh())!; const draft = await preview();
    expect((await fresh())!.answers).toHaveLength(1);
    expect(reviewEditDraft(draft).editStage).toBe('preview');
    expect(h.messages.toUser(TEST_USERS.requesterA).some(m => m.message.text.includes('освещение восстановлено'))).toBe(false);
    await click('review-edit-save', await token());
    const after = (await fresh())!, answer = after.answers.at(-1)!;
    expect(after.status).toBe('WAITING_REVIEW'); expect(after.deadlineAt).toEqual(before.deadlineAt); expect(after.revisionCount).toBe(before.revisionCount);
    expect(answer.version).toBe(2); expect(answer.text).toBe('Здравствуйте, освещение восстановлено.');
    expect(answer.createdByUserId).toBe(executor.userId); expect(after.answers[0]!.text).toBe('Здравствуйте освещение восстановлено.');
    expect(answer.attachments[0]).toMatchObject({ storageKey: 'review-correction.pdf', maxToken: 'file-token', originalName: 'Акт.pdf' });
    expect(await session()).toBeNull();
    expect(await prisma.incidentHistory.findFirst({ where: { incidentId: id, action: 'ANSWER_EDITED_BY_REVIEWER' } })).toMatchObject({ actorMaxUserId: reviewer.maxUserId, metadata: { previousAnswerId: originalId, answerId: answer.id, approver: reviewer.displayName } });
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `review-card:${answer.id}` } })).toMatchObject({ status: 'PENDING' });
    await expect(click('approve', originalId)).rejects.toThrow(/устарела/);
    await click('approve', answer.id);
    expect((await fresh())!.status).toBe('RESOLVED');
    expect(h.messages.toUser(TEST_USERS.requesterA).some(m => m.message.text.includes(answer.text))).toBe(true);
  });

  it('blocks approval and revision of the old text while editing', async () => {
    await preview();
    await expect(click('approve', originalId)).rejects.toThrow(/правку/);
    await expect(click('revision', originalId)).rejects.toThrow(/правку/);
    await expect(h.services.review.requestRevision(id, 'Замечание', reviewer, originalId)).rejects.toThrow(/правку/);
    expect((await fresh())!.status).toBe('WAITING_REVIEW');
  });

  it('cancels without changes and allows immediately starting again', async () => {
    await preview(); const oldToken = await token(); await click('review-edit-cancel', oldToken);
    expect((await fresh())!.answers).toHaveLength(1); expect(await session()).toBeNull();
    await click('review-edit', originalId); await type('Другой исправленный текст.');
    await expect(click('review-edit-save', oldToken)).rejects.toThrow(/устарела/);
    await click('review-edit-save', await token()); expect((await fresh())!.answers.at(-1)!.text).toBe('Другой исправленный текст.');
  });

  it('invalidates the previous preview when correcting again', async () => {
    await preview(); const oldToken = await token(); await click('review-edit-back', oldToken);
    await type('Окончательная правка.');
    await expect(click('review-edit-save', oldToken)).rejects.toThrow(/устарела/);
    await click('review-edit-save', await token()); expect((await fresh())!.answers.at(-1)!.text).toBe('Окончательная правка.');
  });

  it('refuses another employee, wrong chat and an expired lease', async () => {
    await preview(); const t = await token();
    await expect(click('review-edit-save', t, executor)).rejects.toThrow();
    await expect(click('review-edit', originalId, reviewer, TEST_CHATS.sector)).rejects.toThrow();
    await prisma.actionLock.update({ where: { key: `review-queue:${id}` }, data: { lockedUntil: new Date(0) } });
    await expect(click('review-edit-save', t)).rejects.toThrow(/закрепление/);
    expect((await fresh())!.answers).toHaveLength(1);
  });

  it('rejects empty text, attachments and unsolicited replacement of a preview', async () => {
    await click('review-edit', originalId); await type('');
    expect(reviewEditDraft((await session())!).editStage).toBe('text');
    await handleOperatorMessage(h.services, reviewer, TEST_CHATS.review, message('Фото', [{ type: 'image', payload: { token: 'new-photo' } } as never]), (await session())!);
    expect(reviewEditDraft((await session())!).editStage).toBe('text');
    await type(); await type('Случайное сообщение');
    expect(reviewEditDraft((await session())!).text).toBe('Здравствуйте, освещение восстановлено.');
  });

  it('rolls back the answer, audit and session consumption if queueing fails', async () => {
    const draft = await preview(); vi.spyOn(outbox, 'queueAnswer').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(h.services.review.saveCorrection(draft, reviewer)).rejects.toThrow('outbox unavailable');
    expect((await fresh())!.answers).toHaveLength(1); expect(await session()).not.toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: id, action: 'ANSWER_EDITED_BY_REVIEWER' } })).toBe(0);
  });

  it('serializes duplicate saves and approval racing the old answer', async () => {
    const draft = await preview();
    const results = await Promise.allSettled([h.services.review.saveCorrection(draft, reviewer), h.services.review.saveCorrection(draft, reviewer), h.services.review.approve(id, reviewer, originalId)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await fresh())!.answers).toHaveLength(2); expect((await fresh())!.status).toBe('WAITING_REVIEW');
  });

  it('retires old review buttons and keeps the new card current after a delayed old publication', async () => {
    let counter = 0;
    const edits = new Map<string, any[]>();
    const max = { sendToChat: async () => ({ body: { mid: `actual-${++counter}` } }), sendToUser: async () => ({ body: { mid: `actual-${++counter}` } }),
      editMessage: async () => undefined, editCardWithKeyboard: async (mid: string, _text: string, buttons: any[]) => { edits.set(mid, buttons); } };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush();
    const old = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `review-card:${originalId}` } });
    await preview(); await click('review-edit-save', await token());
    const answer = (await fresh())!.answers.at(-1)!;
    await worker.flush(); await worker.flush();
    const latest = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `review-card:${answer.id}` } });
    expect(edits.get(old.firstMessageId!)).toEqual([]);
    expect((await fresh())!.reviewMessageId).toBe(latest.firstMessageId);
    await prisma.outboundMessage.update({ where: { id: old.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    await worker.flush();
    expect((await fresh())!.reviewMessageId).toBe(latest.firstMessageId);
    expect(edits.get(old.firstMessageId!)).toEqual([]);
  });

  async function privateOpen() {
    await invitePersonalWork(h.services, reviewer, TEST_CHATS.review, id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: id } });
    await enterPersonalWork(h.services, reviewer, item.id);
    await personalAction(h.services, reviewer, item.id, 'run', `incident:review-edit:${id}:${originalId}`);
    return item;
  }

  it('edits in private, survives reservation expiry and saves before separately approving', async () => {
    const item = await privateOpen();
    await prisma.actionLock.update({ where: { key: `review-queue:${id}` }, data: { lockedUntil: new Date(0) } });
    await prisma.operatorSession.deleteMany();
    await receivePersonalText(h.services, reviewer, message('Правка в личном диалоге.'));
    expect((await fresh())!.answers).toHaveLength(1);
    await personalAction(h.services, reviewer, item.id, 'resume');
    await personalAction(h.services, reviewer, item.id, 'run', `incident:review-edit-save:${id}:${await token()}`);
    const answer = (await fresh())!.answers.at(-1)!;
    expect(answer.text).toBe('Правка в личном диалоге.');
    expect((await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).data).not.toHaveProperty('session');
    await showPersonalWork(h.services, reviewer, item.id);
    expect(h.messages.toUser(reviewer.maxUserId).at(-1)!.message.keyboard?.flat().some(b => b.type === 'callback' && b.payload.includes(`approve:${id}:${answer.id}`))).toBe(true);
    await personalAction(h.services, reviewer, item.id, 'run', `incident:approve:${id}:${answer.id}`);
    const pending = (await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).data as any;
    await personalAction(h.services, reviewer, item.id, 'confirm', pending.pending.nonce);
    expect((await fresh())!.status).toBe('RESOLVED');
  });

  it('private preview is native, approval is blocked and cancel restores the actions', async () => {
    const item = await privateOpen(); await receivePersonalText(h.services, reviewer, message('Исправленный текст.'));
    expect(reviewEditDraft((await session())!).editStage).toBe('preview');
    await expect(personalAction(h.services, reviewer, item.id, 'run', `incident:approve:${id}:${originalId}`)).rejects.toThrow(/правку/);
    await personalAction(h.services, reviewer, item.id, 'run', `incident:review-edit-cancel:${id}:${await token()}`);
    await showPersonalWork(h.services, reviewer, item.id);
    expect(h.messages.toUser(reviewer.maxUserId).at(-1)!.message.keyboard?.flat().some(b => b.type === 'callback' && b.payload.includes('review-edit:'))).toBe(true);
  });
});
