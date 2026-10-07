import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { enterPersonalWork, invitePersonalWork } from '../../src/work-queues/private-workspace';
import { contextKey } from '../../src/bot/callbacks/executor-context';
import { buildServices } from '../../src/app/container';
import type { Button } from '../../src/max/max-types';
import { MaxError } from '@maxhub/max-bot-api';

describeIntegration.each(['chat', 'private'] as const)('executor context (%s)', mode => {
  let db: PrismaClient, h: TestHarness, actor: Awaited<ReturnType<typeof actorFor>>;
  let incident: Awaited<ReturnType<TestHarness['services']['incidents']['create']>>;
  let group: Awaited<ReturnType<PrismaClient['responsibleGroup']['findFirstOrThrow']>>;
  let itemId: string | undefined, current: string, screens: Map<string, { text: string; keyboard: Button[][] }>;
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect()); afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db); h = await createHarness(db);
    actor = await actorFor(db, TEST_USERS.responder, 'Тестовый исполнитель', [UserRole.RESPONDER]);
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: { getMyInfo: vi.fn(async () => ({ username: 'synthetic_bot' })), getChatMembers: vi.fn(async (_chat, args) => ({ members: args.user_ids.map((id: number) => ({ user_id: id, is_bot: false })) })) } } as never;
    group = await db.responsibleGroup.findFirstOrThrow({ where: { code: GROUP_CODES.facility } });
    incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Тестовый житель', phone: '+79001234567' }, text: 'Исходное сообщение https://example.org/обращение' });
    await db.incident.update({ where: { id: incident.id }, data: { status: 'REVISION_REQUIRED', assignedGroupId: group.id, revisionCount: 7, revisionReason: 'Замечание версии 7', sectorMessageId: 'sector-current' } });
    for (let version = 1; version <= 8; version++) await db.incidentAnswer.create({ data: {
      incidentId: incident.id, version, text: `Ответ версии ${version}`, revisionReason: version <= 7 ? `Замечание версии ${version}` : null,
      status: version <= 7 ? 'REVISION_REQUIRED' : 'DRAFT', createdByUserId: actor.userId,
      attachments: { create: [{ type: 'IMAGE', storageKey: `max-photo:answer-${version}` }, { type: 'FILE', storageKey: `file-${version}`, originalName: `version-${version}.txt` }] },
    } });
    await db.incidentAttachment.createMany({ data: Array.from({ length: 9 }, (_, n) => ({ incidentId: incident.id, type: 'IMAGE', storageKey: `max-photo:original-${n}` })) });
    await h.services.sector.takeInWork(incident.id, actor);
    screens = new Map(); current = 'sector-current'; itemId = undefined;
    const send = h.messages.send.bind(h.messages);
    vi.spyOn(h.messages, 'send').mockImplementation(async (target, message) => {
      const result = await send(target, message);
      if (message.keyboard?.length) { current = result.firstMessageId!; screens.set(current, { text: message.text, keyboard: message.keyboard }); }
      return result;
    });
    vi.spyOn(h.messages, 'editCardKeyboard').mockImplementation(async (mid, text, keyboard) => { current = mid; screens.set(mid, { text, keyboard }); return true; });
    if (mode === 'private') {
      await invitePersonalWork(h.services, actor, group.maxChatId!, incident.id);
      itemId = (await db.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id } })).id;
      await enterPersonalWork(h.services, actor, itemId);
    }
  });
  async function click(payload: string, mid = current) {
    if (itemId && payload.startsWith('incident:')) payload = `personal:run:${itemId}:${payload}`;
    await handleCallbackUpdate(h.services, { update: { message: { recipient: { chat_id: Number(itemId ? actor.maxUserId : group.maxChatId), chat_type: itemId ? 'dialog' : 'chat' }, body: { mid } }, callback: { callback_id: randomUUID(), user: { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false }, payload } } } as never);
  }
  const text = () => screens.get(current)!.text;
  const rows = () => screens.get(current)!.keyboard.flat();
  const btn = (label: string) => { const b = rows().find(b => b.text === label || b.text.startsWith(label)); if (!b || b.type !== 'callback') throw Error(`Missing ${label}: ${text()}`); return b.payload; };
  const open = () => click(`incident:context:${incident.id}`);
  const notice = () => JSON.stringify(vi.mocked(h.services.max.answerCallback).mock.calls.at(-1)?.[1] ?? '');
  const snapshot = async () => JSON.stringify(await Promise.all([
    db.incident.findUnique({ where: { id: incident.id } }), db.incidentAnswer.findMany({ orderBy: { version: 'asc' } }),
    db.incidentHistory.findMany({ orderBy: { id: 'asc' } }), db.incidentAttachment.findMany({ orderBy: { id: 'asc' } }),
    db.answerAttachment.findMany({ orderBy: { id: 'asc' } }), db.operatorSession.findMany({ orderBy: { id: 'asc' } }),
    db.privateWorkItem.findMany({ orderBy: { id: 'asc' } }), db.actionLock.findMany({ where: { action: 'sector-queue' } }), db.outboundMessage.findMany({ orderBy: { id: 'asc' } }),
  ]), (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  async function version(n: number) { await click(btn('История версий')); if (n <= 2) await click(btn('Старше')); await click(btn(`Версия ${n} ·`)); }
  it('shows compact context and seven revision cycles without changing any business data', async () => {
    const before = await snapshot(); await open(); expect(text()).toContain(incident.publicCode); expect(text()).toContain('Замечание версии 7'); expect(text()).toContain('Ответ версии 8');
    await click(btn('История версий')); expect(rows()[0]!.text).toContain('Версия 8'); await click(btn('Старше')); expect(rows()[0]!.text).toContain('Версия 2');
    await click(btn('Версия 1 ·')); expect(text()).toContain('Ответ версии 1'); await click(btn('Замечание к этой версии')); expect(text()).toContain('Замечание версии 1'); expect(text()).not.toContain('Замечание версии 7');
    await click(btn('Назад')); expect(text()).toContain('Ответ версии 1'); expect(await snapshot()).toBe(before);
  });
  it('works without any saved answer or revision', async () => {
    await db.incidentAnswer.deleteMany(); await db.incident.update({ where: { id: incident.id }, data: { revisionCount: 0, revisionReason: null } });
    await open(); expect(text()).toContain('Сохранённого проекта ответа пока нет'); await click(btn('История версий')); expect(text()).toContain('Сохранённых версий ответа нет');
  });
  it('paginates original, answer and remarks losslessly in both directions', async () => {
    const content = ('😀 https://example.org/long?x=1  \n').repeat(250);
    await db.incident.update({ where: { id: incident.id }, data: { text: content } });
    await db.incidentAnswer.updateMany({ where: { incidentId: incident.id, version: 7 }, data: { text: content, revisionReason: content } });
    const readPages = async () => { const out = []; do { out.push(text().split('\n\n').slice(1).join('\n\n')); const next = rows().find(b => b.text === 'Следующая страница →'); if (!next || next.type !== 'callback') break; await click(next.payload); } while (true); expect(out.join('')).toBe(content); await click(btn('← Предыдущая страница')); expect(text()).toContain(`${out.length - 1}/${out.length}`); };
    await open(); await click(btn('Исходный текст')); await readPages(); await open(); await version(7); await readPages(); await click(btn('Замечание к этой версии')); await readPages();
  });
  it('offers every original photo including old sets over four and binds answer files to their own version', async () => {
    const before = await snapshot(); await open(); await click(btn('Исходные фотографии')); expect(text()).toContain(': 9');
    const first = btn('Фото 1'); await click(first); expect(h.messages.sent.at(-1)!.message.attachments).toHaveLength(1);
    await click(btn('Следующие вложения')); expect(rows().filter(b => /^Фото /.test(b.text))).toHaveLength(3); await click(btn('Фото 9'));
    await open(); await version(2); await click(btn('Вложения')); await click(btn('Фото')); expect(h.messages.sent.at(-1)!.message.attachments?.[0]).toMatchObject({ maxToken: 'answer-2' });
    expect(await snapshot()).toBe(before);
  });
  it('explains missing local files without deleting any records', async () => {
    vi.spyOn(h.services.media, 'load').mockRejectedValue(Object.assign(new Error('synthetic absent'), { code: 'ENOENT' }));
    const before = await snapshot(); await open(); await version(3); await click(btn('Вложения')); await click(btn('Файл')); expect(text()).toContain('Вложение недоступно'); expect(await snapshot()).toBe(before);
  });
  it('does not attribute the incident latest remark to an older incomplete version', async () => {
    await db.incidentAnswer.updateMany({ where: { version: 1 }, data: { revisionReason: null } }); await open(); await click(btn('История версий')); expect(text()).toContain('история неполная'); await click(btn('Старше')); await click(btn('Версия 1')); await click(btn('Замечание')); expect(text()).toContain('не сохранено'); expect(text()).not.toContain('Замечание версии 7');
  });
  it('retains pending input and selection through view, pagination and return', async () => {
    const data = { confirmation: { action: 'input', token: randomUUID(), body: { text: 'Незавершённый проект' } }, marker: 'untouched' };
    await db.operatorSession.create({ data: { maxUserId: actor.maxUserId, chatId: group.maxChatId!, incidentId: incident.id, type: 'WAITING_FOR_ANSWER', data, expiresAt: new Date(Date.now()+900000) } });
    if (itemId) { const item = await db.privateWorkItem.findUniqueOrThrow({ where: { id: itemId } }); await db.privateWorkItem.update({ where: { id: itemId }, data: { data: { ...(item.data as object), draft: { text: 'Незавершённый проект', attachments: [], nonce: '', sourceMessageId: 'draft' } } } }); }
    const before = await snapshot(); await open(); await click(btn('Мой незавершённый ввод')); expect(text()).toContain('Незавершённый проект'); await click(btn('Назад')); await click(btn('К текущей рабочей карточке')); expect(await snapshot()).toBe(before);
  });
  it('allows read-only history after reservation expiry without reacquiring it', async () => {
    await db.actionLock.updateMany({ where: { action: 'sector-queue' }, data: { lockedUntil: new Date(0) } }); const before = await snapshot(); await open(); await version(4); await click(btn('К текущей рабочей карточке')); expect(await snapshot()).toBe(before);
  });
  it('rejects access after reassignment even from an old valid screen', async () => {
    await open(); const old = btn('Исходный текст'); const other = await db.responsibleGroup.findFirstOrThrow({ where: { code: GROUP_CODES.it } }); await db.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } }); const n = h.messages.sent.length, edits = h.messages.edits.length; await click(old); expect(notice()).toMatch(/организац|профильн|доступ/); expect(h.messages.sent).toHaveLength(n); expect(h.messages.edits).toHaveLength(edits);
  });
  it('keeps historical version fixed when a new answer appears while browsing', async () => {
    await open(); await version(7); const remark = btn('Замечание'); await db.incidentAnswer.create({ data: { incidentId: incident.id, version: 9, text: 'Новый ответ', createdByUserId: actor.userId } }); await click(remark); expect(text()).toContain('Замечание версии 7'); await click(btn('К текущей рабочей карточке')); expect(text()).toContain('Новый ответ');
  });
  it('rejects repeated and delayed buttons without consuming the current page', async () => {
    await open(); const old = btn('Исходный текст'), mid = current; await click(old); const shown = text(); await click(old, mid); expect(notice()).toMatch(/активен/); expect(text()).toBe(shown); await click(btn('Назад')); expect(text()).toContain('Последнее замечание');
  });
  it('fails closed on an edit error and reopens without touching the employee draft', async () => {
    await open(); const before = await snapshot(); vi.mocked(h.messages.editCardKeyboard).mockResolvedValueOnce(false); await click(btn('История версий')); expect(notice()).toMatch(/Не удалось обновить/); await open(); await version(6); expect(text()).toContain('Ответ версии 6'); expect(await snapshot()).toBe(before);
  });
  it('rechecks assignment after a delayed file read and sends no attachment to the old organization', async () => {
    await open(); await version(4); await click(btn('Вложения'));
    const other = await db.responsibleGroup.findFirstOrThrow({ where: { code: GROUP_CODES.it } });
    vi.spyOn(h.services.media, 'load').mockImplementationOnce(async () => { await db.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } }); return Buffer.from('file'); });
    const before = h.messages.sent.length; await click(btn('Файл')); expect(h.messages.sent).toHaveLength(before); expect(notice()).toMatch(/организац|доступ/);
  });
  it('rechecks chat activation on each request', async () => {
    await open(); await db.responsibleGroup.update({ where: { id: group.id }, data: { isActive: false } }); const before = h.messages.sent.length, acks = vi.mocked(h.services.max.answerCallback).mock.calls.length; await click(btn('Исходный текст')); expect(h.messages.sent).toHaveLength(before); if (mode === 'private') expect(notice()).not.toBe('""'); else expect(vi.mocked(h.services.max.answerCallback).mock.calls).toHaveLength(acks);
  });
  it('survives handler restart with the same saved screen', async () => {
    await open(); const next = btn('История версий'); const max = h.services.max;
    h.services = buildServices(db, { messages: h.messages as never, media: h.services.media }); h.services.max = max;
    await click(next); expect(text()).toContain('от новых версий');
  });
  it('explains an unavailable MAX photo and preserves all source attachments', async () => {
    await open(); await click(btn('Исходные фотографии')); const before = await snapshot();
    vi.mocked(h.messages.send).mockRejectedValueOnce(new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }));
    await click(btn('Фото 1')); expect(text()).toContain('Вложение недоступно'); expect(await snapshot()).toBe(before);
  });
  it('warns about unknown attachment outcome without automatically sending it again', async () => {
    await open(); await click(btn('Исходные фотографии'));
    const before = h.messages.sent.length;
    vi.mocked(h.messages.send).mockRejectedValueOnce(new Error('synthetic lost acknowledgement'));
    await click(btn('Фото 1')); expect(text()).toContain('результат может быть неизвестен'); expect(h.messages.sent).toHaveLength(before);
  });
  it('recovers after initial screen failure without modifying business state', async () => {
    const before = await snapshot(); vi.mocked(h.messages.send).mockRejectedValueOnce(new Error('synthetic 503'));
    await open(); await open(); expect(text()).toContain('Исходное сообщение'); expect(await snapshot()).toBe(before);
  });
  it('does not clear an expired pending session when returning to the working card', async () => {
    await db.operatorSession.create({ data: { maxUserId: actor.maxUserId, chatId: group.maxChatId!, incidentId: incident.id, type: 'WAITING_FOR_ANSWER', data: { confirmation: { action: 'input', token: 'expired', body: { text: 'Сохранить этот текст' } } }, expiresAt: new Date(0) } });
    if (itemId) { const item = await db.privateWorkItem.findUniqueOrThrow({ where: { id: itemId } }); await db.privateWorkItem.update({ where: { id: itemId }, data: { data: { ...(item.data as object), session: { type: 'WAITING_FOR_ANSWER', data: { confirmation: { action: 'input' } } } } } }); }
    const before = await snapshot(); await open(); await click(btn('Мой незавершённый ввод')); expect(text()).toContain('Сохранить этот текст'); await click(btn('К текущей рабочей карточке')); expect(await snapshot()).toBe(before);
  });
  it('serializes concurrent page requests and refuses a late screen result after reassignment', async () => {
    await open(); const payload = btn('Исходный текст');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(h.messages.editCardKeyboard).mockImplementationOnce(async () => { entered(); await gate; return true; });
    const first = click(payload); await started; await click(payload); expect(notice()).toMatch(/загружается|выполняется/);
    const other = await db.responsibleGroup.findFirstOrThrow({ where: { code: GROUP_CODES.it } }); await db.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } }); release(); await first;
    const record = await db.systemSetting.findUniqueOrThrow({ where: { key: contextKey(actor.maxUserId, group.maxChatId!, itemId) } }); expect(JSON.parse(record.value).actions).toBeUndefined();
  });
  if (mode === 'private') it('checks live membership again and does not change another selected incident', async () => {
    await open(); await db.privateWorkItem.update({ where: { id: itemId! }, data: { selected: false } }); const before = await snapshot(); await click(btn('История версий')); expect(await snapshot()).toBe(before);
    vi.mocked(h.services.max.api.getChatMembers).mockResolvedValue({ members: [] } as never); await click(btn('Версия 8')); expect(notice()).toContain('участник');
  });
});
