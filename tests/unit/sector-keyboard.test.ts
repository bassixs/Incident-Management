import { describe, expect, it } from 'vitest';
import { sectorKeyboard } from '../../src/bot/keyboards';

describe('executor controls by incident stage', () => {
  it.each([
    ['ASSIGNED', ['Взять в работу', 'Подготовить ответ', 'Использовать шаблон']],
    ['IN_PROGRESS', ['Подготовить ответ', 'Использовать шаблон']],
    ['REVISION_REQUIRED', ['Исправить ответ']],
    ['WAITING_REVIEW', []], ['RESOLVED', []], ['REJECTED', []], ['DISTRIBUTION', []],
  ])('%s exposes only usable controls', (status, expected) => {
    expect(sectorKeyboard('id', { hasTemplate: true, status }).flat().map(b => b.text)).toEqual(expected);
  });
});
