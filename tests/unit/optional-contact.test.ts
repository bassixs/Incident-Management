import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOwnContact } from '../../src/privacy/optional-contact';
import { incidentDraftConfirmationKeyboard, distributionKeyboard, sectorKeyboard, reviewKeyboard } from '../../src/bot/keyboards';

const token = 'test-contact-token';
const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:79991234567\r\nFN:Private Name\r\nEND:VCARD\r\n';
const signed = (value = vcf) => ({ vcf_info: value, max_info: { user_id: 123 }, hash: createHmac('sha256', token).update(value).digest('hex') });
describe('native MAX own contact', () => {
  it('checks signature and sender; extracts only the normalized phone', () => {
    expect(verifyOwnContact(signed(), 123, token)).toBe('+7 999 123-45-67');
    expect(verifyOwnContact({ ...signed(), tam_info: { user_id: 123 }, max_info: undefined }, 123, token)).toBe('+7 999 123-45-67');
    expect(verifyOwnContact({ ...signed(), hash: createHmac('sha256', token).update(vcf).digest('base64') }, 123, token)).toBe('+7 999 123-45-67');
  });
  it('rejects unsigned, modified, foreign and ambiguous contacts', () => {
    for (const value of [ { ...signed(), hash: undefined }, { ...signed(), hash: 'invalid' },
      { ...signed(), vcf_info: vcf.replace('7999', '7888') }, { ...signed(), max_info: { user_id: 456 } },
      { ...signed(), max_info: undefined }, signed(vcf.replace('END:VCARD', 'TEL:78881234567\r\nEND:VCARD')) ]) {
      expect(verifyOwnContact(value, 123, token)).toBeNull();
    }
    expect(verifyOwnContact(signed(), 123, 'another-bot')).toBeNull();
  });
  it('offers native contact only in an empty preview and binds every callback to its token', () => {
    const rows = incidentDraftConfirmationKeyboard('preview');
    expect(rows.flat()).toContainEqual({ type: 'request_contact', text: '📞 Поделиться контактом' });
    for (const b of rows.flat()) if (b.type === 'callback') expect(b.payload.endsWith(':preview')).toBe(true);
    const pending = incidentDraftConfirmationKeyboard('next', false, true).flat();
    expect(pending.some(b => b.type === 'request_contact' || b.text === '✅ Всё верно')).toBe(false);
    expect(pending.map(b => b.text)).toContain('Добавить номер к этому сообщению');
  });
  it('exposes contact action only where a phone exists and stage permits it', () => {
    const has = (rows: ReturnType<typeof distributionKeyboard>) => rows.flat().some(b => b.text === '📞 Контакт жителя');
    expect(has(distributionKeyboard('id', true))).toBe(true);
    expect(has(distributionKeyboard('id'))).toBe(false);
    for (const status of ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED']) expect(has(sectorKeyboard('id', { hasTemplate: false, status, hasPhone: true }))).toBe(true);
    for (const status of ['WAITING_REVIEW', 'RESOLVED', 'REJECTED']) expect(has(sectorKeyboard('id', { hasTemplate: false, status, hasPhone: true }))).toBe(false);
    expect(has(reviewKeyboard('id', 'answer'))).toBe(false);
  });
});
