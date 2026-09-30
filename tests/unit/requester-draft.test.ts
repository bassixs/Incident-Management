import { describe, expect, it } from 'vitest';

import {
  incidentDraftConfirmationKeyboard,
  incidentDraftEditKeyboard,
  incidentDraftPhotoKeyboard,
} from '../../src/bot/keyboards';
import { incidentDraftPreview, categoryPromptText, municipalityPromptText, incidentPromptText, localityPromptText, customLocalityPromptText } from '../../src/bot/views/cards';
import { OPTIONAL_PHONE_OFFER } from '../../src/privacy/optional-contact';
import { parseCallbackPayload } from '../../src/max/callback-payload';

function labels(rows: ReturnType<typeof incidentDraftEditKeyboard>): string[] {
  return rows.flat().map((button) => button.text);
}

function callback(rows: ReturnType<typeof incidentDraftEditKeyboard>, label: string) {
  const button = rows.flat().find((item) => item.text === label);
  return parseCallbackPayload((button as { payload?: string } | undefined)?.payload);
}

describe('requester incident draft', () => {
  it.each([
    { requesterPhone: '+7 900 123-45-67' },
    {},
  ])('shows the next step appropriate to the phone state: %j', (contact) => {
    const text = incidentDraftPreview({
      ...contact, problemMunicipalityName: 'Город Калуга',
      draftText: 'Не работает фонарь', photoCount: 0,
    });
    expect(text).toContain('Сообщение ещё не отправлено. Если всё указано правильно, нажмите «Всё верно».');
    if ('requesterPhone' in contact) expect(text).not.toContain(OPTIONAL_PHONE_OFFER);
    else expect(text).toContain('Для более оперативной обработки сообщения можно оставить телефон по кнопке "поделится контактом"');
    expect(text).not.toContain('Добавить номер к этому сообщению');
  });

  it('keeps only the topic prompt and removes obsolete step numbering throughout the resident flow', () => {
    expect(categoryPromptText()).toBe('Выберите тему сообщения');
    for (const text of [categoryPromptText(), municipalityPromptText(10), incidentPromptText(), localityPromptText('Калуга'), customLocalityPromptText('Калуга')]) {
      expect(text).not.toMatch(/Шаг\s*\d/);
    }
  });

  it('shows every entered field and makes clear that nothing was sent yet', () => {
    const text = incidentDraftPreview(
      {
        requesterName: 'Иванов Иван Иванович',
        requesterPhone: '+7 900 123-45-67',
        problemMunicipalityName: 'Жуковский округ',
        problemLocality: 'Кременки',
        draftText: 'Не работает фонарь',
        photoCount: 2,
      },
      'Благоустройство',
    );

    expect(text).not.toContain('Иванов Иван Иванович');
    expect(text).toContain('Телефон для связи: +7 900 123-45-67');
    expect(text).toContain('Благоустройство');
    expect(text).toContain('Жуковский округ → Кременки');
    expect(text).toContain('Не работает фонарь');
    expect(text).toContain('Фотографии: 2');
    expect(text).toContain('ещё не отправлено');
  });

  it('offers confirmation and correction of each concrete field', () => {
    const confirmation = incidentDraftConfirmationKeyboard();
    expect(labels(confirmation)).toEqual(['📞 Поделиться контактом', '✅ Всё верно', '✏️ Исправить', 'Отмена']);
    expect(callback(confirmation, '✅ Всё верно')).toEqual({ kind: 'user', action: 'draft-confirm' });

    const edit = incidentDraftEditKeyboard(true);
    expect(labels(edit)).toEqual([
      'Сфера сообщения',
      'Территория и населённый пункт',
      'Текст сообщения',
      'Фотографии',
      '⬅️ Назад к проверке',
    ]);
    expect(callback(edit, 'Текст сообщения')).toEqual({
      kind: 'user',
      action: 'draft-field',
      argument: 'text',
    });
  });

  it('allows existing photos to be replaced or removed', () => {
    const photo = incidentDraftPhotoKeyboard(true);
    expect(labels(photo)).toEqual(['Заменить фотографии', 'Удалить фотографии', '⬅️ Назад']);
    expect(callback(photo, 'Удалить фотографии')).toEqual({
      kind: 'user',
      action: 'draft-photo',
      argument: 'remove',
    });
  });
});
