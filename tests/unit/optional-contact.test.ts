import { describe, expect, it } from 'vitest';
import { parseManualPhone } from '../../src/privacy/optional-contact';
import { incidentDraftConfirmationKeyboard, incidentDraftEditKeyboard, distributionKeyboard, sectorKeyboard, reviewKeyboard } from '../../src/bot/keyboards';
describe('manual optional phone', () => {
  it.each(['+7 900 123-45-67', '8 (900) 123-45-67', '89001234567', '+79001234567', '+7 (900) 123 45 67'])('normalizes %s', raw => {
    expect(parseManualPhone(raw)).toBe('+7 900 123-45-67');
  });
  it.each(['', '9001234567', '79001234567', '+1 900 1234567', '890012345678', '8 (900 1234567', '+7 900) 1234567', '+7 ((900))1234567', '+7.900.1234567', '+7 900 1234567 добавочный 12', 'паспорт 45 12 123456', '89001234567 89001234568', '+7 900\n1234567'])('rejects %s', raw => {
    expect(parseManualPhone(raw)).toBeNull();
  });
  it('uses token-bound callbacks, hides the offer after addition, allows editing/removal', () => {
    const rows = incidentDraftConfirmationKeyboard('preview').flat();
    expect(rows).toContainEqual({ type: 'callback', text: '📞 Поделиться контактом', payload: 'user:draft-phone-enter:preview' });
    expect(rows.every(b => b.type === 'callback' && b.payload.endsWith(':preview'))).toBe(true);
    expect(incidentDraftConfirmationKeyboard('next', true).flat().map(b => b.text)).toEqual(['✅ Всё верно', '✏️ Исправить', 'Отмена']);
    expect(incidentDraftEditKeyboard(true, true, 'edit').flat()).toEqual(expect.arrayContaining([
      { type: 'callback', text: 'Изменить номер', payload: 'user:draft-phone-enter:edit' },
      { type: 'callback', text: 'Убрать номер', payload: 'user:draft-phone-remove:edit' },
    ]));
  });
  it('has no separate contact or mandatory privacy verification buttons at any stage', () => {
    const rows = [distributionKeyboard('id', true), reviewKeyboard('id', 'answer'), ...['ASSIGNED','IN_PROGRESS','REVISION_REQUIRED','WAITING_REVIEW','RESOLVED','REJECTED'].map(status=>sectorKeyboard('id', { hasTemplate:false, status, hasPhone:true }))].flat(2);
    expect(rows.some(b=> b.type==='callback' && /incident:(contact|privacy-pass):/.test(b.payload))).toBe(false);
  });
});
