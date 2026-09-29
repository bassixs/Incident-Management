import { MaxError } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';
import { PinnedPanelService, panelRecoveryKey, STALE_PANEL_TEXT } from '../../src/max/pinned-panel.service';
import { workButtons } from '../../src/work-queues/state';

describeIntegration('durable pinned panel recovery', () => {
  let db: PrismaClient; let service: PinnedPanelService; let max: any; let jobId: string;
  let messages: Map<string, any>; let pin: string | undefined; let sequence: number;
  const chat = -1002n, key = `work-panel:${chat}`, botId = 777;
  const text = '📋 ОЧЕРЕДЬ ПРОФИЛЬНОГО ЧАТА\n\nОжидают обработки: 0\nСвободны: 0 · В работе: 0\n\nПанель обновляется каждую минуту.';
  const notFound = () => new MaxError(404, { code: 'message.not.found', message: 'Gone or inaccessible' });
  const unavailable = () => new MaxError(503, { code: 'service.unavailable', message: 'Unavailable' });
  const refresh = () => service.refresh(chat, key, text, workButtons(), jobId);
  const currentId = async () => (await db.systemSetting.findUniqueOrThrow({ where: { key } })).value;
  const put = (bodyText = text, senderId = botId, controls: unknown[] = []) => {
    const id = `panel-${++sequence}`;
    messages.set(id, { sender: { user_id: senderId, is_bot: true }, recipient: { chat_id: Number(chat) }, timestamp: Date.now(), body: { mid: id, text: bodyText, attachments: controls } });
    return structuredClone(messages.get(id));
  };
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(async () => {
    await resetDatabase(db); messages = new Map(); pin = undefined; sequence = 0;
    max = {
      getMe: vi.fn(async () => ({ user_id: botId })),
      getMessage: vi.fn(async (id: string) => { if (!messages.has(id)) throw notFound(); return structuredClone(messages.get(id)); }),
      getPinnedMessage: vi.fn(async () => ({ message: pin ? structuredClone(messages.get(pin)) : null })),
      getChatMessages: vi.fn(async () => ({ messages: [...messages.values()].map(m => structuredClone(m)) })),
      sendPanelOnce: vi.fn(async (_chat: bigint, value: string) => put(value)),
      editMessage: vi.fn(async (id: string, value: string, attachments: unknown[]) => { if (!messages.has(id)) throw notFound(); messages.get(id).body = { mid: id, text: value, attachments }; }),
      pinMessage: vi.fn(async (_chat: bigint, id: string) => { pin = id; return { success: true }; }),
    };
    jobId = (await db.outboundMessage.create({ data: { dedupeKey: key, targetType: 'chat', targetId: chat, status: 'SENDING', payload: { operation: { type: 'work-panel' } }, attachments: [] } })).id;
    service = new PinnedPanelService(db, max);
  });

  it('keeps identity, controls and pin across an ordinary restart', async () => {
    await refresh(); const id = await currentId();
    service = new PinnedPanelService(db, max); await refresh();
    expect(await currentId()).toBe(id); expect(pin).toBe(id);
    expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
    expect(messages.get(id).body.attachments[0].payload.buttons).toEqual(workButtons());
  });
  it.each(['read', 'edit'])('keeps the known ID after 503 during %s', async (operation) => {
    await refresh(); const id = await currentId();
    if (operation === 'read') max.getMessage.mockRejectedValueOnce(unavailable());
    else { messages.get(id).body.attachments = []; max.editMessage.mockRejectedValueOnce(unavailable()); }
    await expect(refresh()).rejects.toThrow();
    expect(await currentId()).toBe(id); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
    await refresh(); expect(pin).toBe(id);
  });
  it('does not recreate on edit 404, or on a read 404 contradicted by pin/history', async () => {
    await refresh(); const id = await currentId();
    messages.get(id).body.attachments = []; max.editMessage.mockRejectedValueOnce(notFound());
    await expect(refresh()).rejects.toThrow(); expect(await currentId()).toBe(id);
    max.getMessage.mockRejectedValueOnce(notFound()); await refresh();
    expect(await currentId()).toBe(id); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
  });
  it('confirms deletion on a later sweep before creating a replacement', async () => {
    await refresh(); const id = await currentId(); messages.delete(id); pin = undefined;
    await expect(refresh()).rejects.toThrow('confirmation');
    expect(await currentId()).toBe(id); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 6_000);
    await refresh(); expect(await currentId()).not.toBe(id); expect(pin).toBe(await currentId());
    expect(max.sendPanelOnce).toHaveBeenCalledTimes(2);
  });
  it('adopts an existing bot panel when its SystemSetting is missing', async () => {
    await refresh(); const id = await currentId(); await db.systemSetting.delete({ where: { key } });
    await refresh(); expect(await currentId()).toBe(id); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
  });
  it('recovers a successful send after a crash before saving ID; provisional copy has no buttons', async () => {
    // Prisma delegates are dynamic proxies; wrap instead of spying on them.
    const interrupted = { systemSetting: db.systemSetting, outboundMessage: db.outboundMessage,
      $transaction: vi.fn().mockRejectedValueOnce(new Error('Simulated crash before saving ID')) };
    service = new PinnedPanelService(interrupted as never, max);
    await expect(refresh()).rejects.toThrow('Simulated crash');
    expect(await db.systemSetting.findUnique({ where: { key } })).toBeNull();
    expect(messages.get('panel-1').body.attachments).toEqual([]);
    expect(JSON.parse((await db.systemSetting.findUniqueOrThrow({ where: { key: panelRecoveryKey(key) } })).value).intentAt).toBeTypeOf('number');
    service = new PinnedPanelService(db, max); await refresh();
    expect(await currentId()).toBe('panel-1'); expect(pin).toBe('panel-1'); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
  });
  it('reconciles an accepted POST whose response was 503 without another POST', async () => {
    max.sendPanelOnce.mockImplementationOnce(async () => { put(); throw unavailable(); });
    await expect(refresh()).rejects.toThrow(); await refresh();
    expect(await currentId()).toBe('panel-1'); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
  });
  it('keeps the committed identity when pinning fails before outbox completion', async () => {
    max.pinMessage.mockRejectedValueOnce(unavailable()); await expect(refresh()).rejects.toThrow();
    expect(await currentId()).toBe('panel-1');
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: jobId } })).firstMessageId).toBe('panel-1');
    service = new PinnedPanelService(db, max); await refresh();
    expect(pin).toBe('panel-1'); expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
  });
  it('does not resend an ambiguous POST while history cannot reveal its outcome', async () => {
    max.sendPanelOnce.mockRejectedValueOnce(unavailable());
    await expect(refresh()).rejects.toThrow();
    service = new PinnedPanelService(db, max);
    await expect(refresh()).rejects.toThrow('unknown');
    expect(max.sendPanelOnce).toHaveBeenCalledTimes(1);
    expect(await db.systemSetting.findUnique({ where: { key } })).toBeNull();
  });
  it('retires confirmed duplicate bot panels and leaves resident cards and other authors intact', async () => {
    const controls = [{ type: 'inline_keyboard', payload: { buttons: workButtons() } }];
    const old = put(text, botId, controls), fresh = put(text, botId, controls); pin = fresh.body.mid;
    const resident = put('🆕 НОВОЕ СООБЩЕНИЕ\n№ INC-000001', botId, controls);
    const foreign = put(text, 999, controls);
    await refresh(); expect(await currentId()).toBe(fresh.body.mid);
    expect(messages.get(old.body.mid).body).toMatchObject({ text: STALE_PANEL_TEXT, attachments: [] });
    expect(messages.get(resident.body.mid)).toEqual(resident); expect(messages.get(foreign.body.mid)).toEqual(foreign);
    expect(max.sendPanelOnce).not.toHaveBeenCalled();
  });
  it('fails closed on incomplete history instead of concluding that the panel is missing', async () => {
    max.getChatMessages.mockImplementation(async (_chat: bigint, before: number) => ({ messages: Array.from({ length: 100 }, (_, i) => ({ ...put('unrelated'), timestamp: before - i - 1 })) }));
    await expect(refresh()).rejects.toThrow('scan limit'); expect(max.sendPanelOnce).not.toHaveBeenCalled();
  });
});
