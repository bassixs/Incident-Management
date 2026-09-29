import { Bot, MaxError } from '@maxhub/max-bot-api';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MaxClient } from '../../src/max/max-client';
import { getConfig } from '../../src/config';
import { ValidationError } from '../../src/utils/errors';

afterEach(() => vi.unstubAllGlobals());

it('never retries the non-idempotent panel POST after 503', async () => {
  const bot = new Bot('test-token');
  const send = vi.spyOn(bot.api, 'sendMessageToChat').mockRejectedValue(new MaxError(503, { code: 'unavailable', message: 'Unknown outcome' }));
  await expect(new MaxClient(bot).sendPanelOnce(-1002n, 'Panel')).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(-1002, 'Panel', { notify: false });
});

describe('updating card controls without losing photos', () => {
  it('retains link previews and photos when refreshing an old card', async () => {
    const bot = new Bot('test-token');
    vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { attachments: [
      { type: 'share', payload: { token: 'preview-token', url: 'https://example.org' } },
      { type: 'image', payload: { token: 'photo-token' } },
    ] } } as never);
    const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
    await new MaxClient(bot).editCardWithKeyboard('card', 'Распределено', []);
    expect(edit).toHaveBeenCalledWith('card', { text: 'Распределено', attachments: [
      { type: 'share', payload: { token: 'preview-token', url: 'https://example.org' } },
      { type: 'image', payload: { token: 'photo-token' } },
    ] });
  });
  it('skips unchanged edits but repairs externally changed buttons on the next read', async () => {
    const bot = new Bot('test-token');
    const buttons = [[{ type: 'callback' as const, text: 'Согласовать', payload: 'current' }]];
    const get = vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { text: 'Ответ', attachments: [
      { type: 'image', payload: { token: 'photo' } }, { type: 'inline_keyboard', payload: { buttons } },
    ] } } as never);
    const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
    const client = new MaxClient(bot);
    await client.editCardWithKeyboard('card', 'Ответ', buttons);
    await client.editCardWithKeyboard('card', 'Ответ', buttons);
    expect(get).toHaveBeenCalledTimes(2); expect(edit).not.toHaveBeenCalled();
    get.mockResolvedValue({ body: { text: 'Ответ', attachments: [{ type: 'image', payload: { token: 'photo' } }] } } as never);
    await client.editCardWithKeyboard('card', 'Ответ', buttons);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith('card', { text: 'Ответ', attachments: [
      { type: 'image', payload: { token: 'photo' } }, { type: 'inline_keyboard', payload: { buttons } },
    ] });
  });

  it('keeps every existing photo token and removes only the keyboard on completion', async () => {
    const bot = new Bot('test-token');
    vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { attachments: [
      { type: 'image', payload: { token: 'photo-one', url: 'https://unused.test/one' } },
      { type: 'image', payload: { token: 'photo-two', url: 'https://unused.test/two' } },
      { type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: 'Старая', payload: 'old' }]] } },
    ] } } as never);
    const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
    await new MaxClient(bot).editCardWithKeyboard('card', 'Отработано', []);
    expect(edit).toHaveBeenCalledWith('card', { text: 'Отработано', attachments: [
      { type: 'image', payload: { token: 'photo-one' } }, { type: 'image', payload: { token: 'photo-two' } },
    ] });
  });

  it('restores the current controls and retains a legacy file', async () => {
    const bot = new Bot('test-token');
    vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { attachments: [{ type: 'file', payload: { token: 'file-token' } }] } } as never);
    const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
    const buttons = [[{ type: 'callback' as const, text: 'Исправить ответ', payload: 'fix' }]];
    await new MaxClient(bot).editCardWithKeyboard('card', 'На доработке', buttons);
    expect(edit).toHaveBeenCalledWith('card', { text: 'На доработке', attachments: [
      { type: 'file', payload: { token: 'file-token' } }, { type: 'inline_keyboard', payload: { buttons } },
    ] });
  });

  it('does not erase attachments if MAX cannot provide a reusable token', async () => {
    const bot = new Bot('test-token');
    vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { attachments: [{ type: 'image', payload: { url: 'https://unused.test' } }] } } as never);
    const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
    await expect(new MaxClient(bot).editCardWithKeyboard('card', 'Отработано', [])).rejects.toThrow('сохранить вложения');
    expect(edit).not.toHaveBeenCalled();
  });
});

describe('file uploads', () => {
  it.each([undefined, 'guide.pdf'])('uses the token-preserving SDK path and retries missing tokens for %s', async name => {
    const bot = new Bot('test');
    let stagedPath = '';
    const upload = vi.spyOn(bot.api.upload, 'file').mockImplementation(async ({ source }) => {
      expect(typeof source).toBe('string');
      stagedPath = source as string;
      expect((await fs.readFile(stagedPath)).toString()).toBe('document');
      return (upload.mock.calls.length === 1 ? {} : { token: 'valid-token' }) as never;
    });
    expect(await new MaxClient(bot).uploadFile(Buffer.from('document'), name)).toEqual({ type: 'file', payload: { token: 'valid-token' } });
    expect(upload).toHaveBeenCalledTimes(2);
    await expect(fs.access(stagedPath)).rejects.toThrow();
  });

  it('fails after bounded retries instead of returning a file without a token', async () => {
    const bot = new Bot('test');
    const upload = vi.spyOn(bot.api.upload, 'file').mockResolvedValue({} as never);
    await expect(new MaxClient(bot).uploadFile(Buffer.from('document'), 'guide.pdf')).rejects.toThrow('токен');
    expect(upload).toHaveBeenCalledTimes(4);
    await expect(fs.access(upload.mock.calls[0]![0].source as string)).rejects.toThrow();
  });
});

describe('callback acknowledgement', () => {
  it.each([undefined, '', '   '])('sends a nonempty notification for %j', async (notice) => {
    const bot = new Bot('test-token');
    const answer = vi.spyOn(bot.api, 'answerOnCallback').mockResolvedValue({ success: true });
    await new MaxClient(bot).answerCallback('callback-id', notice);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('callback-id', { notification: 'Принято.' });
  });

  it('preserves a specific result or error notification', async () => {
    const bot = new Bot('test-token');
    const answer = vi.spyOn(bot.api, 'answerOnCallback').mockResolvedValue({ success: true });
    await new MaxClient(bot).answerCallback('callback-id', 'Нет доступа.');
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('callback-id', { notification: 'Нет доступа.' });
  });
});

describe('bounded attachment download', () => {
  const limit = getConfig().MEDIA_MAX_FILE_MB * 1024 * 1024;

  function streamingResponse(parts: Uint8Array[], headers: Record<string, string> = {}) {
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[reads++];
        if (part) controller.enqueue(part);
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { headers }));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, cancel, reads: () => reads };
  }

  it('preserves all bytes and MIME type at the exact size limit', async () => {
    const parts = [Buffer.alloc(limit / 2, 1), Buffer.alloc(limit / 2, 2)];
    streamingResponse(parts, { 'content-type': 'application/pdf' });
    const result = await new MaxClient(new Bot('test')).downloadFromUrl('https://example.test/file');
    expect(result.body.equals(Buffer.concat(parts))).toBe(true);
    expect(result.mimeType).toBe('application/pdf');
  });

  it('rejects a large Content-Length before reading and does not retry', async () => {
    const source = streamingResponse([Buffer.from('unread')], { 'content-length': String(limit + 1) });
    await expect(new MaxClient(new Bot('test')).downloadFromUrl('https://example.test/file')).rejects.toBeInstanceOf(ValidationError);
    expect(source.reads()).toBe(0);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.fetchMock).toHaveBeenCalledTimes(1);
    expect(source.fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it.each<Record<string, string>>([{}, { 'content-length': '1' }, { 'content-length': 'invalid' }])(
    'stops at the actual limit with missing or misleading headers %j', async (headers) => {
      const source = streamingResponse([Buffer.alloc(limit), Buffer.from('!'), Buffer.from('unread')], headers);
      await expect(new MaxClient(new Bot('test')).downloadFromUrl('https://example.test/file')).rejects.toThrow('20 МБ');
      expect(source.reads()).toBe(2);
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(source.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('discards a broken stream and retries with a fresh timeout signal', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('connection lost')); },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(broken))
      .mockResolvedValueOnce(new Response('complete'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MaxClient(new Bot('test')).downloadFromUrl('https://example.test/file');
    expect(result.body.toString()).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].signal).not.toBe(fetchMock.mock.calls[1]![1].signal);
  });
});
