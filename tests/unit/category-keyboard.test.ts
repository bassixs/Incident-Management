import type { Category } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_PAGE_SIZE,
  categoryPageCount,
  requesterCategoryKeyboard,
} from '../../src/bot/keyboards';
import { parseCallbackPayload } from '../../src/max/callback-payload';

function categories(count: number): Category[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `11111111-2222-3333-4444-${String(index).padStart(12, '0')}`,
        code: `C${index}`,
        name: `Сфера ${index}`,
        isActive: true,
      }) as Category,
  );
}

/** Labels of every button, flattened, so tests read like the screen. */
function labels(rows: ReturnType<typeof requesterCategoryKeyboard>): string[] {
  return rows.flat().map((button) => button.text);
}

describe('paged сфера picker', () => {
  it('shows one page of сферы with "Иное" pinned on top', () => {
    const rows = requesterCategoryKeyboard(categories(26), 0);
    expect(labels(rows)[0]).toBe('Иное');
    expect(labels(rows).filter((text) => text.startsWith('Сфера'))).toHaveLength(CATEGORY_PAGE_SIZE);
  });

  it('offers only forward navigation on the first page', () => {
    const nav = labels(requesterCategoryKeyboard(categories(26), 0));
    expect(nav).toContain('Вперёд ➡️');
    expect(nav).not.toContain('⬅️ Назад');
    expect(nav).toContain('1 / 5');
  });

  it('offers both directions in the middle', () => {
    const nav = labels(requesterCategoryKeyboard(categories(26), 2));
    expect(nav).toContain('⬅️ Назад');
    expect(nav).toContain('Вперёд ➡️');
    expect(nav).toContain('3 / 5');
  });

  it('offers only backward navigation on the last page', () => {
    const nav = labels(requesterCategoryKeyboard(categories(26), 4));
    expect(nav).toContain('⬅️ Назад');
    expect(nav).not.toContain('Вперёд ➡️');
    // 26 сфер over pages of 6 leaves two on the final page.
    expect(nav.filter((text) => text.startsWith('Сфера'))).toHaveLength(2);
  });

  it('hides navigation entirely when everything fits on one page', () => {
    const nav = labels(requesterCategoryKeyboard(categories(4), 0));
    expect(nav).toEqual(['Иное', 'Сфера 0', 'Сфера 1', 'Сфера 2', 'Сфера 3']);
  });

  it('clamps an out-of-range page instead of showing an empty screen', () => {
    expect(labels(requesterCategoryKeyboard(categories(26), 99))).toContain('5 / 5');
    expect(labels(requesterCategoryKeyboard(categories(26), -3))).toContain('1 / 5');
  });

  it('covers every сфера exactly once across all pages', () => {
    const all = categories(26);
    const seen = new Set<string>();
    for (let page = 0; page < categoryPageCount(all.length); page += 1) {
      for (const text of labels(requesterCategoryKeyboard(all, page))) {
        if (text.startsWith('Сфера')) {
          expect(seen.has(text)).toBe(false);
          seen.add(text);
        }
      }
    }
    expect(seen.size).toBe(26);
  });

  it('emits navigation payloads the router understands', () => {
    const forward = requesterCategoryKeyboard(categories(26), 0)
      .flat()
      .find((button) => button.text === 'Вперёд ➡️');
    expect(parseCallbackPayload((forward as { payload: string }).payload)).toEqual({
      kind: 'user',
      action: 'page',
      argument: '1',
    });
  });

  it('makes the page counter inert', () => {
    const counter = requesterCategoryKeyboard(categories(26), 1)
      .flat()
      .find((button) => button.text === '2 / 5');
    expect(parseCallbackPayload((counter as { payload: string }).payload)).toEqual({ kind: 'noop' });
  });

  it('survives an empty сфера list', () => {
    expect(labels(requesterCategoryKeyboard([], 0))).toEqual(['Иное']);
  });
});
