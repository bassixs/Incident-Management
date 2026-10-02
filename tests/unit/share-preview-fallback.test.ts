import { Bot, MaxError } from '@maxhub/max-bot-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxClient } from '../../src/max/max-client';

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

describe('specific MAX 400 share fallback', () => {
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
