import { describe, expect, it } from 'vitest';
import { mainMenuKeyboard, incidentDraftEditKeyboard } from '../../src/bot/keyboards';
describe('resident menus without contact collection', () => {
  it('offers no contact button or phone/name editor', () => {
    const buttons = [...mainMenuKeyboard(), ...incidentDraftEditKeyboard(true)].flat();
    expect(buttons.some(b => b.type === 'request_contact')).toBe(false);
    expect(buttons.map(b => b.text).join(' ')).not.toMatch(/ФИО|телефон|контакт/i);
  });
});
