import { expect, it, vi } from 'vitest';
import { MediaService } from '../../src/media/media.service';
import { loadOutboundAttachments } from '../../src/media/attachment-loader';
import { MaxMessageService } from '../../src/max/max-message.service';
import { IncidentService } from '../../src/incidents/incident.service';
import { AnswerService } from '../../src/answers/answer.service';
import { ValidationError, isExpectedUserError } from '../../src/utils/errors';

it('refuses an image without a usable download URL', async () => {
  const media = new MediaService({} as never, {} as never);
  await expect(media.ingestAll('draft', [{ kind: 'IMAGE' }])).rejects.toThrow('Прикрепите его заново');
});

it('cleans the first attachment if downloading the second fails', async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  const storage = { save: async () => ({ storageKey: 'first', size: 3 }), remove };
  const max = { downloadFromUrl: vi.fn().mockResolvedValueOnce({ body: Buffer.from('one') }).mockRejectedValueOnce(new Error('download failed')) };
  const media = new MediaService(storage as never, max as never);
  await expect(media.ingestAll('draft', [{ kind: 'IMAGE', url: 'first' }, { kind: 'IMAGE', url: 'second' }])).rejects.toThrow('Не удалось сохранить');
  expect(remove).toHaveBeenCalledWith('first');
});

it('rejects oversized metadata without downloading or saving a file', async () => {
  const downloadFromUrl = vi.fn();
  const save = vi.fn();
  const media = new MediaService({ save } as never, { downloadFromUrl } as never);
  await expect(media.ingest('draft', { kind: 'FILE', url: 'file', size: 21 * 1024 * 1024 })).rejects.toThrow('20 МБ');
  expect(downloadFromUrl).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it('keeps the size refusal user-visible, cleans prior files, and avoids inbox retries', async () => {
  const refusal = new ValidationError('Вложение слишком большое. Максимальный размер — 20 МБ.');
  const remove = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn().mockResolvedValue({ storageKey: 'first', size: 3 });
  const downloadFromUrl = vi.fn().mockResolvedValueOnce({ body: Buffer.from('one') }).mockRejectedValueOnce(refusal);
  const media = new MediaService({ save, remove } as never, { downloadFromUrl } as never);
  await expect(media.ingestAll('draft', [{ kind: 'IMAGE', url: 'first' }, { kind: 'IMAGE', url: 'large' }])).rejects.toBe(refusal);
  expect(remove).toHaveBeenCalledWith('first');
  expect(save).toHaveBeenCalledTimes(1);
  expect(isExpectedUserError(refusal)).toBe(true);
});

it('fails loading a stored answer instead of silently dropping its file', async () => {
  const media = new MediaService({ load: async () => { throw new Error('missing file'); } } as never, {} as never);
  await expect(loadOutboundAttachments(media, [{ storageKey: 'missing', type: 'FILE', originalName: 'answer.pdf' }])).rejects.toThrow('missing file');
});

it('does not send text as a successful answer when attachment upload fails', async () => {
  const max = { uploadImage: vi.fn().mockRejectedValue(new Error('upload failed')), sendToUser: vi.fn() };
  const messages = new MaxMessageService(max as never);
  await expect(messages.send({ userId: 1n }, { text: 'Ответ', attachments: [{ type: 'IMAGE', body: Buffer.from('photo') }] })).rejects.toThrow('upload failed');
  expect(max.sendToUser).not.toHaveBeenCalled();
});

it('explicitly rejects unsupported attachments even when accompanied by valid text', () => {
  expect(() => IncidentService.prototype.validateSubmission('Текст', [{ kind: 'FILE' }])).toThrow('только фотографии');
  expect(() => AnswerService.prototype.validate('Ответ', [{ kind: 'AUDIO' }])).toThrow('фотографии или файлы');
  expect(() => AnswerService.prototype.validate('Ответ', [{ kind: 'OTHER' }])).toThrow('фотографии или файлы');
});
