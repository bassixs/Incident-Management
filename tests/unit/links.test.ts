import { expect, it } from 'vitest';
import { containsLink, messageContainsLink } from '../../src/utils/links';

it.each(['https://max.ru/test', 'HTTP://example.org', 'www.example.org', 'max.ru/test', 't.me/name', 'пример.рф', 'example.com', 'tg://resolve?domain=test', 'https://127.0.0.1', 'https://exa\u200Bmple.org'])('detects %s', text => {
  expect(containsLink(text)).toBe(true);
});

it.each(['ул.Ленина, д.12', '28.09.2026', 'Не горит фонарь № 3', '8.30–17.00', 'г.Калуга', '+7 900 123-45-67'])('accepts ordinary resident text: %s', text => {
  expect(containsLink(text)).toBe(false);
});

it('detects hidden links, previews and forwarded links but permits photo download URLs', () => {
  expect(messageContainsLink({ body: { text: 'Нажмите здесь', markup: [{ type: 'link', url: 'https://example.org' }] } } as never)).toBe(true);
  expect(messageContainsLink({ body: { attachments: [{ type: 'share', payload: { token: 'preview' } }] } } as never)).toBe(true);
  expect(messageContainsLink({ body: { text: 'Описание', attachments: [{ type: 'image', payload: { url: 'https://photo.test/image' } }] } } as never)).toBe(false);
  expect(messageContainsLink({ body: { text: 'Смотрите' }, link: { type: 'forward', message: { text: 'https://example.org' } } } as never)).toBe(true);
  expect(messageContainsLink({ body: { text: 'Ответ' }, link: { type: 'reply', message: { text: 'https://example.org' } } } as never)).toBe(false);
});
