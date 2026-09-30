import { expect, it, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';

const draft = {
  selectedCategoryId: null,
  problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга',
  problemLocality: null, draftText: 'Не работает фонарь',
};
function harness() {
  let current: any = null;
  return {
    sessions: {
      start: vi.fn(async (input) => { current = { ...structuredClone(input), id: 'draft-session' }; return structuredClone(current); }),
      find: vi.fn(async () => structuredClone(current)),
      readData: (session: any) => session.data,
      replaceCurrent: vi.fn(async (_expected, type, data) => { current = { ...current, type, data: structuredClone(data) }; return true; }),
    },
    categories: { findById: vi.fn().mockResolvedValue(null) },
    max: { downloadFromUrl: vi.fn() },
    messages: { send: vi.fn().mockResolvedValue({ state: 'sent', firstMessageId: 'preview' }) },
  };
}
it.each([
  new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }),
])('preserves draft fields and offers replacement when MAX refuses the preview: %s', async error => {
  const services = harness();
  services.messages.send.mockRejectedValueOnce(error);
  await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: [{ kind: 'IMAGE', token: 'old' }] });
  expect(services.sessions.replaceCurrent).toHaveBeenCalledWith(expect.anything(), 'WAITING_INCIDENT_EDIT_VALUE',
    expect.objectContaining({ ...draft, draftMedia: [], draftEditField: 'photo', draftPhotoRetry: true }));
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
    expect((await services.sessions.find())!.type).toBe('WAITING_INCIDENT_EDIT_VALUE');
  });
it('sends tokens without downloading bytes and enables confirmation only after MAX accepts the preview', async () => {
  const services = harness();
  let finish!: (value: { state: string; firstMessageId: string }) => void;
  services.messages.send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const operation = showIncidentDraftPreview(services as never, 1n, 1n, { ...draft,
    draftPhotoRetry: true, draftEditField: 'photo', draftMedia: [{ kind: 'IMAGE', token: 'a' }, { kind: 'IMAGE', token: 'b' }],
  });
  await vi.waitFor(() => expect(services.messages.send).toHaveBeenCalledTimes(1));
  expect((await services.sessions.find())!.data.previewDeliveryPending).toBe(true);
  const message = services.messages.send.mock.calls[0]![1];
  expect(message.immediatePreview).toBe(true);
  expect(message.attachments.map((a: { maxToken: string }) => a.maxToken)).toEqual(['a', 'b']);
  expect(message.text).toContain('Фотографии: 2');
  finish({ state: 'sent', firstMessageId: 'preview' });
  await operation;
  const saved = await services.sessions.find();
  expect(saved.type).toBe('WAITING_INCIDENT_CONFIRMATION');
  expect(saved.data.draftPhotoRetry).toBeUndefined();
  expect(saved.data.previewDeliveryPending).toBeUndefined();
  expect(services.max.downloadFromUrl).not.toHaveBeenCalled();
});

it.each([new MaxError(503, { code: 'unavailable', message: 'Private error' }), new Error('private network failure')])(
  'keeps photo tokens and offers retry on temporary failure: %s', async error => {
    const services = harness(); services.messages.send.mockRejectedValueOnce(error);
    const photos = [{ kind: 'IMAGE' as const, token: 'photo' }];
    await showIncidentDraftPreview(services as never, 1n, 1n, { ...draft, draftMedia: photos });
    expect((await services.sessions.find()).data).toMatchObject({ ...draft, draftMedia: photos, previewDeliveryPending: true });
    const hint = services.messages.send.mock.calls.at(-1)![1];
    expect(hint.text).not.toContain('private'); expect(hint.text).not.toContain('заново');
    expect(hint.keyboard.flat().map((b: { text: string }) => b.text)).toEqual(['Повторить показ карточки', 'Отмена']);
  },
);
