import { it, expect, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { photoReference, photoToken, isUnavailablePhoto } from '../../src/media/max-photo-reference';
import { MediaService } from '../../src/media/media.service';
import { loadOutboundAttachments } from '../../src/media/attachment-loader';
import { MaxMessageService } from '../../src/max/max-message.service';

it('roundtrips opaque MAX tokens, including punctuation and unicode', () => {
  const token = 'a/b+c=:/%аб';
  expect(photoToken(photoReference(token))).toBe(token);
  expect(photoToken('incidents/old.jpg')).toBeUndefined();
});
it('ingests and sends photo references without file storage, download or upload', async () => {
  const storage = { save: vi.fn(), load: vi.fn(), remove: vi.fn() };
  const max = { downloadFromUrl: vi.fn(), uploadImage: vi.fn(), sendToChat: vi.fn().mockResolvedValue({ body: { mid: 'card' } }) };
  const media = new MediaService(storage as never, max as never);
  const stored = await media.ingest('incident', { kind: 'IMAGE', token: 'existing', url: 'temporary' });
  const attachments = await loadOutboundAttachments(media, [{ ...stored, originalName: null }]);
  await new MaxMessageService(max as never).send({ chatId: 1n }, { text: 'Карточка', attachments });
  expect(max.sendToChat.mock.calls[0]![2].attachments).toEqual([{ type: 'image', payload: { token: 'existing' } }]);
  await media.discard([stored]);
  for (const fn of [storage.save, storage.load, storage.remove, max.downloadFromUrl, max.uploadImage]) expect(fn).not.toHaveBeenCalled();
});
it('only treats explicit permanent media refusals as unavailable photos', () => {
  expect(isUnavailablePhoto(new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }))).toBe(true);
  for (const [status, code, message] of [[400, 'attachment.not.ready', 'Photo processing'], [429, 'limit', 'token unavailable'], [500, 'internal', 'attachment not found'], [400, 'chat.invalid', 'Invalid chat']] as const) {
    expect(isUnavailablePhoto(new MaxError(status, { code, message }))).toBe(false);
  }
});
