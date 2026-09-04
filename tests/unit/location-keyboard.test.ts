import { describe, expect, it } from 'vitest';

import {
  MUNICIPALITY_PAGE_SIZE,
  municipalityPageCount,
  requesterLocalityKeyboard,
  requesterMunicipalityKeyboard,
} from '../../src/bot/keyboards';
import {
  PROBLEM_MUNICIPALITIES,
  findProblemMunicipality,
} from '../../src/locations/problem-locations';
import { parseCallbackPayload } from '../../src/max/callback-payload';

const CATEGORY_ID = '11111111-2222-3333-4444-555555555555';

function labels(rows: ReturnType<typeof requesterMunicipalityKeyboard>): string[] {
  return rows.flat().map((button) => button.text);
}

describe('выбор территории проблемы', () => {
  it('contains all 27 agreed municipality-level options', () => {
    expect(PROBLEM_MUNICIPALITIES).toHaveLength(27);
    expect(new Set(PROBLEM_MUNICIPALITIES.map((item) => item.code)).size).toBe(27);
  });

  it('shows six territories per page with navigation', () => {
    const first = labels(requesterMunicipalityKeyboard(CATEGORY_ID, PROBLEM_MUNICIPALITIES, 0));
    expect(first.filter((label) => PROBLEM_MUNICIPALITIES.some((item) => item.name === label))).toHaveLength(
      MUNICIPALITY_PAGE_SIZE,
    );
    expect(first).toContain('1 / 5');
    expect(first).toContain('Вперёд ➡️');
    expect(municipalityPageCount(PROBLEM_MUNICIPALITIES.length)).toBe(5);
  });

  it('covers every territory exactly once across all pages', () => {
    const seen = new Set<string>();
    for (let page = 0; page < municipalityPageCount(PROBLEM_MUNICIPALITIES.length); page += 1) {
      for (const label of labels(requesterMunicipalityKeyboard(null, PROBLEM_MUNICIPALITIES, page))) {
        if (PROBLEM_MUNICIPALITIES.some((item) => item.name === label)) seen.add(label);
      }
    }
    expect(seen.size).toBe(PROBLEM_MUNICIPALITIES.length);
  });

  it('preserves the selected topic in a paging callback', () => {
    const next = requesterMunicipalityKeyboard(CATEGORY_ID, PROBLEM_MUNICIPALITIES, 0)
      .flat()
      .find((button) => button.text === 'Вперёд ➡️') as { payload: string };
    expect(parseCallbackPayload(next.payload)).toEqual({
      kind: 'user',
      action: 'location-page',
      argument: `${CATEGORY_ID}~1`,
    });
  });

  it('offers listed localities, custom input and skip', () => {
    const municipality = findProblemMunicipality('YUKHNOVSKY')!;
    const rows = requesterLocalityKeyboard(CATEGORY_ID, municipality);
    expect(rows.flat().map((button) => button.text)).toEqual([
      'Юхнов',
      'Щелканово',
      'Другой',
      'Пропустить',
    ]);
    const other = rows.flat().find((button) => button.text === 'Другой') as { payload: string };
    expect(parseCallbackPayload(other.payload)).toEqual({
      kind: 'user',
      action: 'locality',
      argument: `${CATEGORY_ID}~YUKHNOVSKY~other`,
    });
  });

  it('has no duplicate locality codes inside a territory', () => {
    for (const municipality of PROBLEM_MUNICIPALITIES) {
      expect(new Set(municipality.localities.map((item) => item.code)).size).toBe(
        municipality.localities.length,
      );
    }
  });
});
