import { describe, expect, it } from 'vitest';

import {
  incidentDraftConfirmationKeyboard,
  incidentDraftEditKeyboard,
  incidentDraftPhotoKeyboard,
} from '../../src/bot/keyboards';
import { incidentDraftPreview } from '../../src/bot/views/cards';
import { parseCallbackPayload } from '../../src/max/callback-payload';

function labels(rows: ReturnType<typeof incidentDraftEditKeyboard>): string[] {
  return rows.flat().map((button) => button.text);
}

function callback(rows: ReturnType<typeof incidentDraftEditKeyboard>, label: string) {
  const button = rows.flat().find((item) => item.text === label);
  return parseCallbackPayload((button as { payload?: string } | undefined)?.payload);
}

describe('requester incident draft', () => {
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

    expect(text).toContain('Иванов Иван Иванович');
    expect(text).toContain('+7 900 123-45-67');
    expect(text).toContain('Благоустройство');
    expect(text).toContain('Жуковский округ → Кременки');
    expect(text).toContain('Не работает фонарь');
    expect(text).toContain('Фотографии: 2');
    expect(text).toContain('ещё не отправлено');
  });

  it('offers confirmation and correction of each concrete field', () => {
    const confirmation = incidentDraftConfirmationKeyboard();
    expect(labels(confirmation)).toEqual(['✅ Всё верно', '✏️ Исправить']);
    expect(callback(confirmation, '✅ Всё верно')).toEqual({ kind: 'user', action: 'draft-confirm' });

    const edit = incidentDraftEditKeyboard(true);
    expect(labels(edit)).toEqual([
      'ФИО',
      'Номер телефона',
      'Сфера обращения',
      'Территория и населённый пункт',
      'Текст обращения',
      'Фотографии',
      '⬅️ Назад к проверке',
    ]);
    expect(callback(edit, 'Текст обращения')).toEqual({
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
