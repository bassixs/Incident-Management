import { expect, it, vi } from 'vitest';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';
import { ValidationError } from '../../src/utils/errors';
import type { IncomingMedia } from '../../src/media/media.service';

const draft = {
  requesterName: 'Иванов Иван', requesterPhone: '+7 900 111-22-33', selectedCategoryId: null,
  problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга',
  problemLocality: null, draftText: 'Не работает фонарь',
};
function harness() {
  return {
    sessions: { start: vi.fn().mockResolvedValue({}) },
    categories: { findById: vi.fn().mockResolvedValue(null) },
    max: { downloadFromUrl: vi.fn().mockResolvedValue({ body: Buffer.from('photo') }) },
    messages: { send: vi.fn().mockResolvedValue({ state: 'sent' }) },
  };
}

it.each([
  ['oversized', new ValidationError('Максимальный размер одного файла — 20 МБ.'), '20 МБ'],
  ['network failure', new Error('private download URL or upstream diagnostic'), 'Не удалось загрузить'],
])('offers replacement instead of a misleading confirmation on %s', async (_label, failure, notice) => {
  const services = harness();
  services.max.downloadFromUrl.mockRejectedValueOnce(failure);
  await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [{ kind: 'IMAGE', url: 'large' }] });
  expect(services.sessions.start).toHaveBeenCalledTimes(1);
  expect(services.sessions.start).toHaveBeenCalledWith(expect.objectContaining({
    type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftMedia: [], draftEditField: 'photo', draftPhotoRetry: true },
  }));
  const message = services.messages.send.mock.calls[0]![1];
  expect(message.text).toContain(notice);
  expect(message.text).toContain('данные сохранены');
  expect(message.text).not.toContain('private');
  expect(message.text).not.toContain('Фотографии:');
  expect(message.attachments).toBeUndefined();
  expect(message.keyboard.flat().map((button: { text: string }) => button.text)).toEqual(['Продолжить без фотографий']);
});

it.each<IncomingMedia>([
  { kind: 'IMAGE' },
  { kind: 'IMAGE', url: 'large', size: 21 * 1024 * 1024 },
])('refuses unusable photo metadata before downloading: %j', async photo => {
  const services = harness();
  await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [photo] });
  expect(services.max.downloadFromUrl).not.toHaveBeenCalled();
  expect(services.sessions.start.mock.calls[0]![0].type).toBe('WAITING_INCIDENT_EDIT_VALUE');
});

it('does not send a partial photo set if the second download fails', async () => {
  const services = harness();
  services.max.downloadFromUrl.mockResolvedValueOnce({ body: Buffer.from('first') }).mockRejectedValueOnce(new Error('offline'));
  await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [
    { kind: 'IMAGE', url: 'first' }, { kind: 'IMAGE', url: 'second' },
  ] });
  expect(services.messages.send).toHaveBeenCalledTimes(1);
  expect(services.messages.send.mock.calls[0]![1].attachments).toBeUndefined();
  expect(services.sessions.start.mock.calls[0]![0].data.draftMedia).toEqual([]);
});

it('waits for every photo before enabling confirmation and reports the verified count', async () => {
  const services = harness();
  let finish!: (value: { body: Buffer }) => void;
  const pending = new Promise<{ body: Buffer }>(resolve => { finish = resolve; });
  services.max.downloadFromUrl.mockResolvedValueOnce({ body: Buffer.from('first') }).mockReturnValueOnce(pending);
  const preview = showIncidentDraftPreview(services as never, 1n, 1n, { ...draft,
    draftEditField: 'photo', draftPhotoRetry: true,
    draftMedia: [{ kind: 'IMAGE', url: 'first' }, { kind: 'IMAGE', url: 'second' }],
  });
  await vi.waitFor(() => expect(services.max.downloadFromUrl).toHaveBeenCalledTimes(2));
  expect(services.sessions.start).not.toHaveBeenCalled();
  expect(services.messages.send).not.toHaveBeenCalled();
  finish({ body: Buffer.from('second') });
  await preview;
  const session = services.sessions.start.mock.calls[0]![0];
  expect(session.type).toBe('WAITING_INCIDENT_CONFIRMATION');
  expect(session.data.draftPhotoRetry).toBeUndefined();
  expect(session.data.draftEditField).toBeUndefined();
  const message = services.messages.send.mock.calls[0]![1];
  expect(message.text).toContain('Фотографии: 2');
  expect(message.attachments.map((photo: { body: Buffer }) => photo.body.toString())).toEqual(['first', 'second']);
});
