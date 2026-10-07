import { describe, expect, it } from 'vitest';
import { contextPages, excerpt, executorSummary } from '../../src/bot/views/executor-context';
import { revisionCard } from '../../src/bot/views/cards';

describe('compact executor context', () => {
  it('paginates long Unicode content losslessly, including links and whitespace', () => {
    const text = ('😀 Текст\n https://example.org/a?x=1  \n').repeat(420);
    const pages = contextPages(text);
    expect(pages.length).toBeGreaterThan(3); expect(pages.join('')).toBe(text);
    expect(pages.every(p => Array.from(p).length <= 2400)).toBe(true);
  });
  it('keeps short input verbatim and makes only previews shorter', () => {
    expect(excerpt(' Ссылка https://example.org ')).toBe(' Ссылка https://example.org ');
    expect(excerpt('я'.repeat(500))).toHaveLength(221);
    expect(contextPages('')).toEqual(['']);
  });
  it('keeps the returned card compact without concatenating historical versions', () => {
    const incident = { publicCode: 'INC-TEST', text: 'исходное'.repeat(1000), revisionReason: 'замечание'.repeat(900), attachments: Array(9).fill({}),
      answers: Array.from({ length: 8 }, (_, i) => ({ version: i+1, text: `версия-${i+1} ` + 'ответ'.repeat(1500) })) } as never;
    const text = revisionCard(incident, 8, 'замечание'.repeat(900));
    expect(text.length).toBeLessThan(1500); expect(text).toContain('INC-TEST'); expect(text).toContain('версия-8'); expect(text).not.toContain('версия-7');
    expect(executorSummary(incident).join('\n')).toContain('Исходных вложений: 9');
  });
});
