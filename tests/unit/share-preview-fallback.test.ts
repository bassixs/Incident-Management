import { Bot, MaxError } from '@maxhub/max-bot-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxClient } from '../../src/max/max-client';
import { reviewCard } from '../../src/bot/views/cards';
import type { LeaseView } from '../../src/work-queues/leases';

const url = 'https://example.org/help';
const share = { type: 'share', payload: { url, token: 'unusable-preview' } };
const photo = { type: 'image', payload: { token: 'photo' } };
const file = { type: 'file', payload: { token: 'file' } };
const buttons = [[{ type: 'callback' as const, text: 'Согласовать', payload: 'current' }]];
const keyboard = { type: 'inline_keyboard', payload: { buttons } };
const failure = () => new MaxError(400, { code: 'attachment.invalid', message: 'No valid url or token provided for share attachment' });

function fixture(attachments: unknown[], text = 'Прежний ответ') {
  const bot = new Bot('isolated-test-token');
  let card = { body: { text, attachments } };
  const get = vi.spyOn(bot.api, 'getMessage').mockImplementation(async () => structuredClone(card) as never);
  const edit = vi.spyOn(bot.api, 'editMessage').mockImplementation(async (_mid, extra) => {
    if (extra?.attachments?.some(a => a.type === 'share')) throw failure();
    card = { body: { text: extra?.text ?? '', attachments: extra?.attachments ?? [] } };
    return { success: true };
  });
  return { client: new MaxClient(bot), get, edit, card: () => card };
}
afterEach(() => vi.restoreAllMocks());

function reviewText(lease: LeaseView = null, text = 'Освещение восстановлено.', version = 1, code = 'INC-000001') {
  const incident = { publicCode: code, text: 'Не работает фонарь.', answers: [],
    createdAt: new Date('2026-10-01T10:00:00Z'), deadlineAt: new Date('2026-10-05T10:00:00Z'),
    problemMunicipalityName: 'Тестовая территория', attachments: [] };
  return reviewCard(incident as unknown as Parameters<typeof reviewCard>[0],
    { text, version, attachments: [] } as unknown as Parameters<typeof reviewCard>[1], null, lease);
}

const lease = { name: 'Тестовый сотрудник', until: new Date('2026-10-02T10:15:00Z') };

describe('specific MAX 400 share fallback', () => {
  it('keeps an appended URL through reservation changes and replay without a returned share attachment', async () => {
    const f = fixture([photo, share]);
    await f.client.editCardWithKeyboard('card', reviewText(), buttons);
    expect(f.card().body.text).toBe(`${reviewText()}\n\nСсылка из предпросмотра: ${url}`);
    expect(f.card().body.attachments.some(a => (a as { type: string }).type === 'share')).toBe(false);
    for (const reservation of [lease, { ...lease, name: 'Другой сотрудник' }, null]) {
      // New client proves that preservation does not depend on an in-memory cache.
      const client = new MaxClient(f.client.bot);
      await client.editCardWithKeyboard('card', reviewText(reservation), buttons);
      expect(f.card().body.text).toBe(`${reviewText(reservation)}\n\nСсылка из предпросмотра: ${url}`);
      expect(f.card().body.attachments).toEqual([photo, keyboard]);
      const calls = f.edit.mock.calls.length;
      await client.editCardWithKeyboard('card', reviewText(reservation), buttons);
      expect(f.edit).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([
    { reason: 'new answer text', next: () => reviewText(lease, 'Новый ответ.') },
    { reason: 'new version with identical text', next: () => reviewText(lease, undefined, 2) },
    { reason: 'different incident', next: () => reviewText(lease, undefined, 1, 'INC-000002') },
    { reason: 'deliberate redaction', next: () => 'Содержимое удалено' },
    { reason: 'lease-like line inside the answer', next: () => reviewText(lease, 'Ответ\n🟢 Свободно — можно взять в работу') },
  ])('does not carry an old URL into $reason', async ({ next }) => {
    const f = fixture([photo, share]);
    await f.client.editCardWithKeyboard('card', reviewText(), buttons);
    await f.client.editCardWithKeyboard('card', next(), []);
    expect(f.card().body.text).toBe(next());
    expect(f.card().body.text).not.toContain(url);
    await f.client.editCardWithKeyboard('card', next(), []);
    expect(f.edit).toHaveBeenCalledTimes(3);
  });

  it('does not discard the URL when a longer reservation header would exceed the limit', async () => {
    const f = fixture([photo, share]);
    await f.client.editCardWithKeyboard('card', reviewText(), buttons);
    const original = structuredClone(f.card());
    const intended = reviewText({ ...lease, name: lease.name + 'Я'.repeat(3990 - Array.from(reviewText(lease)).length) });
    expect(Array.from(intended)).toHaveLength(3990);
    await expect(f.client.editCardWithKeyboard('card', intended, buttons)).rejects.toThrow();
    expect(f.card()).toEqual(original);
    expect(f.edit).toHaveBeenCalledTimes(2);
  });

  it('preserves all trailing URLs after a failed service update and its retry', async () => {
    const second = 'https://example.org/second';
    const f = fixture([photo, share, { type: 'share', payload: { url: second, token: 'second-preview' } }]);
    await f.client.editCardWithKeyboard('card', reviewText(), buttons);
    const original = structuredClone(f.card());
    f.edit.mockRejectedValueOnce(new MaxError(403, { code: 'forbidden', message: 'Temporary access failure' }));
    await expect(f.client.editCardWithKeyboard('card', reviewText(lease), buttons)).rejects.toThrow();
    expect(f.card()).toEqual(original);
    await new MaxClient(f.client.bot).editCardWithKeyboard('card', reviewText(lease), buttons);
    expect(f.card().body.text).toBe(`${reviewText(lease)}\n\nСсылка из предпросмотра: ${url}\n\nСсылка из предпросмотра: ${second}`);
    expect(f.card().body.attachments).toEqual([photo, keyboard]);
    await f.client.editCardWithKeyboard('card', reviewText(lease), buttons);
    expect(f.edit).toHaveBeenCalledTimes(4);
  });

  it('does not normalise reservation-looking lines inside an answer', async () => {
    const f = fixture([photo, share]);
    const oldAnswer = 'Ответ\n🟢 Свободно — можно взять в работу\nКонец';
    await f.client.editCardWithKeyboard('card', reviewText(null, oldAnswer), buttons);
    const changedAnswer = 'Ответ\n👤 Закреплено за: Тест\n⏳ До 02.10.2026 13:15 (МСК)\nКонец';
    await f.client.editCardWithKeyboard('card', reviewText(lease, changedAnswer), buttons);
    expect(f.card().body.text).toBe(reviewText(lease, changedAnswer));
    expect(f.card().body.text).not.toContain(url);
  });

  it.each([{ attachments: [photo, file, share] }, { attachments: [share] }])('keeps the answer, URL, other attachments and current controls: %j', async ({ attachments }) => {
    const f = fixture(attachments);
    const text = `Исправленный ответ ${url}`;
    await f.client.editCardWithKeyboard('card', text, buttons);
    expect(f.edit).toHaveBeenCalledTimes(2);
    expect(f.edit.mock.calls[0]![1]!.attachments).toContainEqual(share);
    expect(f.card().body).toEqual({ text, attachments: [...attachments.filter(a => a.type !== 'share'), keyboard] });
    await f.client.editCardWithKeyboard('card', text, buttons);
    expect(f.edit).toHaveBeenCalledTimes(2);
  });

  it('retains a URL absent from the intended text on replay after a partial update, without restoring obsolete content', async () => {
    const f = fixture([photo, share]);
    await f.client.editCardWithKeyboard('card', 'Актуальный ответ', buttons);
    expect(f.card().body.text).toBe(`Актуальный ответ\n\nСсылка из предпросмотра: ${url}`);
    await f.client.editCardWithKeyboard('card', 'Актуальный ответ', buttons);
    expect(f.edit).toHaveBeenCalledTimes(2);
    await f.client.editCardWithKeyboard('card', 'Актуальный ответ', []);
    expect(f.card().body.text).toContain(url);
    expect(f.card().body.attachments).toEqual([photo]);
    await f.client.editCardWithKeyboard('card', 'Содержимое удалено', []);
    expect(f.card().body.text).toBe('Содержимое удалено');
  });

  it('keeps normal cards on the existing single-edit path', async () => {
    const f = fixture([photo, file]);
    await f.client.editCardWithKeyboard('card', 'Без ссылки', buttons);
    expect(f.edit).toHaveBeenCalledTimes(1);
    expect(f.card().body.attachments).toEqual([photo, file, keyboard]);
  });

  it('does not discard an unknown attachment', async () => {
    const f = fixture([share, { type: 'future_type', payload: { token: 'unknown' } }]);
    await expect(f.client.editCardWithKeyboard('card', 'Ответ', buttons)).rejects.toThrow('сохранить вложения');
    expect(f.edit).not.toHaveBeenCalled();
  });

  it.each([
    new MaxError(400, { code: 'invalid', message: 'Different error' }),
    new MaxError(403, { code: 'forbidden', message: 'No valid url or token provided for share attachment' }),
  ])('does not suppress a different error: %s', async error => {
    const f = fixture([share, photo]); f.edit.mockRejectedValue(error);
    await expect(f.client.editCardWithKeyboard('card', 'Ответ', buttons)).rejects.toBe(error);
    expect(f.edit).toHaveBeenCalledTimes(1);
  });

  it('does not suppress the same error without a share attachment', async () => {
    const f = fixture([photo]); const error = failure(); f.edit.mockRejectedValue(error);
    await expect(f.client.editCardWithKeyboard('card', 'Ответ', buttons)).rejects.toBe(error);
    expect(f.edit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'share', payload: { token: 'preview-without-url' } },
    { type: 'share', payload: { url: 'javascript:alert(1)' } },
  ])('fails closed if the URL cannot be preserved: %j', async attachment => {
    const f = fixture([attachment]);
    await expect(f.client.editCardWithKeyboard('card', 'Ответ', buttons)).rejects.toThrow('No valid url');
    expect(f.edit).toHaveBeenCalledTimes(1);
  });

  it('never truncates an answer to make room for the retained link', async () => {
    const f = fixture([share]);
    await expect(f.client.editCardWithKeyboard('card', 'Я'.repeat(4000), buttons)).rejects.toThrow('No valid url');
    expect(f.edit).toHaveBeenCalledTimes(1);
    expect(f.card().body.text).toBe('Прежний ответ');
  });

  it('propagates a failed fallback and retries from the actual card on the next delivery', async () => {
    const f = fixture([share, photo]); const workingEdit = f.edit.getMockImplementation()!;
    f.edit.mockRejectedValueOnce(failure()).mockRejectedValueOnce(new MaxError(400, { code: 'other', message: 'Another failure' }));
    await expect(f.client.editCardWithKeyboard('card', `Ответ ${url}`, buttons)).rejects.toThrow('Another failure');
    expect(f.card().body.attachments).toEqual([share, photo]);
    f.edit.mockImplementation(workingEdit);
    await f.client.editCardWithKeyboard('card', `Ответ ${url}`, buttons);
    expect(f.card().body.attachments).toEqual([photo, keyboard]);
  });

  it.each([false, true])('requires success=true from MAX, including fallback=%s', async fallback => {
    const f = fixture(fallback ? [share, photo] : [photo]);
    if (fallback) f.edit.mockRejectedValueOnce(failure());
    f.edit.mockResolvedValue({ success: false, message: 'Rejected by MAX' });
    await expect(f.client.editCardWithKeyboard('card', `Ответ ${url}`, buttons)).rejects.toThrow('не подтвердил');
    expect(f.edit).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect(f.card().body.text).toBe('Прежний ответ');
  });
});
