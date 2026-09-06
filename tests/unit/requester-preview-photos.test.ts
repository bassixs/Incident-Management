import { expect, it, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';

const draft = {
  requesterName: 'Иванов Иван', requesterPhone: '+7 900 111-22-33', selectedCategoryId: null,
  problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга',
  problemLocality: null, draftText: 'Не работает фонарь',
};
function harness() {
  return {
    sessions: { start: vi.fn().mockResolvedValue({}) },
    categories: { findById: vi.fn().mockResolvedValue(null) },
    max: { downloadFromUrl: vi.fn() },
    messages: { send: vi.fn().mockResolvedValue({ state: 'sent' }) },
  };
}
it.each([
  new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }),
  new Error('private upstream details'),
])('preserves draft fields and offers replacement when MAX refuses the preview: %s', async error => {
  const services = harness();
  services.messages.send.mockRejectedValueOnce(error);
  await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [{ kind: 'IMAGE', token: 'old' }] });
  expect(services.sessions.start).toHaveBeenCalledWith(expect.objectContaining({
    type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftMedia: [], draftEditField: 'photo', draftPhotoRetry: true },
  }));
  const notice = services.messages.send.mock.calls.at(-1)![1];
  expect(notice.text).toContain('данные сохранены');
  expect(notice.text).not.toContain('private');
  expect(notice.keyboard.flat().map((b: { text: string }) => b.text)).toEqual(['Продолжить без фотографий']);
  expect(services.max.downloadFromUrl).not.toHaveBeenCalled();
});
it.each([{ kind: 'IMAGE' as const, url: 'url-only' }, { kind: 'IMAGE' as const, token: 'large', size: 21 * 1024 * 1024 }])(
  'refuses unusable metadata before sending a confirmation: %j', async photo => {
    const services = harness();
    await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [photo] });
    expect(services.messages.send).toHaveBeenCalledTimes(1);
    expect(services.messages.send.mock.calls[0]![1].attachments).toBeUndefined();
    expect(services.sessions.start.mock.calls[0]![0].type).toBe('WAITING_INCIDENT_EDIT_VALUE');
  });
it('sends tokens without downloading bytes and enables confirmation only after MAX accepts the preview', async () => {
  const services = harness();
  let finish!: (value: { state: string }) => void;
  services.messages.send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const operation = showIncidentDraftPreview(services as never, 1n, 1n, { ...draft,
    draftPhotoRetry: true, draftEditField: 'photo', draftMedia: [{ kind: 'IMAGE', token: 'a' }, { kind: 'IMAGE', token: 'b' }],
  });
  await vi.waitFor(() => expect(services.messages.send).toHaveBeenCalledTimes(1));
  expect(services.sessions.start).not.toHaveBeenCalled();
  const message = services.messages.send.mock.calls[0]![1];
  expect(message.immediatePreview).toBe(true);
  expect(message.attachments.map((a: { maxToken: string }) => a.maxToken)).toEqual(['a', 'b']);
  expect(message.text).toContain('Фотографии: 2');
  finish({ state: 'sent' });
  await operation;
  expect(services.sessions.start.mock.calls[0]![0].type).toBe('WAITING_INCIDENT_CONFIRMATION');
  expect(services.sessions.start.mock.calls[0]![0].data.draftPhotoRetry).toBeUndefined();
  expect(services.max.downloadFromUrl).not.toHaveBeenCalled();
});
