import { describe, expect, it } from 'vitest';
import { containsPersonalData } from '../../src/privacy/personal-data';
import { minimiseInbound } from '../../src/privacy/inbound-privacy';

describe('resident privacy screening', () => {
  it.each(['+7 (900) 123-45-67', '8 900 123 45 67', '79001234567', '89001234567',
    '+79001234567', '8(900)1234567', '+7-900-123-45-67', '+7 4842 123456',
    'телефон: +7 (900) 123-45-67', 'тел. 8 900 123 45 67', 'моб. 89001234567'])('allows phone: %s', phone => {
    expect(containsPersonalData(`У дома 12 на ул. Ленина яма. Для связи ${phone}.`)).toBe(false);
  });
  it.each(['Иванов Иван Иванович', 'Паспорт 45 12 123456', 'СНИЛС 79001234567',
    'ИНН 89001234567', 'номер карты 79001234567', 'расчётный счёт 79001234567',
    '123-456-789 01', '7900123456789012', '479001234567', '1234567890',
    '40817810000000000001', '7900 1234 5678 9012', 'test@example.ru'])('phone does not hide other data: %s', forbidden => {
    expect(containsPersonalData(`Для связи +79001234567, ${forbidden}`)).toBe(true);
  });
  it.each(['паспорт 45 12 123456', '123-456-789 01',
    'Иванов Иван Иванович', 'иванов иван иванович', 'Иванов И. И.', 'Меня зовут Олег', 'email: test@example.ru', 'СНИЛС: 12345678901'])('rejects %s', text => {
    expect(containsPersonalData(text)).toBe(true);
  });
  it.each(['У дома 12 по улице Ленина не работает фонарь.', 'Яма на дороге. Прошу исправить.', 'INC-000123', 'ул. Циолковского, дом 7', 'Ремонт нужен 29.09.2026'])('keeps problem description: %s', text => {
    expect(containsPersonalData(text)).toBe(false);
  });
  it('drops rejected text, contacts, forwarding metadata and resident names before persistence', async () => {
    const update = { update_type: 'message_created', message: { sender: { user_id: 1, name: 'Секретное Имя', username: 'secret', is_bot: false },
      recipient: { chat_type: 'dialog', chat_id: 2 }, body: { mid: 'm1', text: '+79001234567', attachments: [{ type: 'contact', payload: { vcf_info: 'secret' } }] }, link: { message: { body: { text: 'secret' } } } } };
    const db = { privateWorkItem: { findFirst: async () => null }, operatorSession: { findUnique: async () => null } };
    const result = await minimiseInbound(update as never, db as never);
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret'); expect(text).not.toContain('7900'); expect(text).not.toContain('Секретное');
    expect(result).toHaveProperty('contactRejected', true);
    expect(update.message.body.text).toBe('+79001234567');
  });
  it('does not apply resident screening to a selected employee workspace', async () => {
    const update = { update_type: 'message_created', message: { sender: { user_id: 1, name: 'Сотрудник' }, recipient: { chat_type: 'dialog' }, body: { text: 'Контакт службы +79001234567' } } };
    const result = await minimiseInbound(update as never, { privateWorkItem: { findFirst: async () => ({ id: 'work' }) } } as never);
    expect(result).not.toHaveProperty('privacyRejected');
    expect(JSON.stringify(result)).toContain('+79001234567');
  });

});
