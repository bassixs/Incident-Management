import { describe, expect, it } from 'vitest';
import { mainMenuKeyboard, incidentDraftEditKeyboard } from '../../src/bot/keyboards';
describe('resident menus with optional draft phone', () => {
  it('keeps native contact/profile collection absent and offers only token-bound manual input', () => {
    const main = mainMenuKeyboard().flat();
    const edit = incidentDraftEditKeyboard(true, false, 'preview-token').flat();
    const buttons = [...main, ...edit];
    expect(buttons.some(b => b.type === 'request_contact')).toBe(false);
    expect(main.map(b => b.text).join(' ')).not.toMatch(/ФИО|телефон|контакт/i);
    expect(edit.map(b => b.text).join(' ')).not.toMatch(/ФИО/i);
    expect(edit.find(b => b.text === '📞 Поделиться контактом')).toEqual({
      type: 'callback', text: '📞 Поделиться контактом', payload: 'user:draft-phone-enter:preview-token',
    });
  });
});
