import { ResponsibleGroupKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { RESPONSIBLE_GROUPS } from '../../src/responsible-groups/catalog';

describe('каталог ответственных групп', () => {
  it('contains exactly 1 regional, 26 local and 23 executive groups', () => {
    expect(RESPONSIBLE_GROUPS).toHaveLength(50);
    expect(RESPONSIBLE_GROUPS.filter((group) => group.kind === ResponsibleGroupKind.REGIONAL)).toHaveLength(1);
    expect(
      RESPONSIBLE_GROUPS.filter((group) => group.kind === ResponsibleGroupKind.LOCAL_GOVERNMENT),
    ).toHaveLength(26);
    expect(
      RESPONSIBLE_GROUPS.filter((group) => group.kind === ResponsibleGroupKind.EXECUTIVE_AUTHORITY),
    ).toHaveLength(23);
  });

  it('has unique stable codes and chat ids', () => {
    expect(new Set(RESPONSIBLE_GROUPS.map((group) => group.code)).size).toBe(RESPONSIBLE_GROUPS.length);
    expect(new Set(RESPONSIBLE_GROUPS.map((group) => group.maxChatId)).size).toBe(RESPONSIBLE_GROUPS.length);
  });

  it('maps every municipality to no more than one group', () => {
    const municipalityCodes = RESPONSIBLE_GROUPS.flatMap((group) =>
      group.municipalityCode ? [group.municipalityCode] : [],
    );
    expect(new Set(municipalityCodes).size).toBe(municipalityCodes.length);
    expect(municipalityCodes).toHaveLength(27);
  });

  it('allows direct answers only for Kaluga Region', () => {
    expect(RESPONSIBLE_GROUPS.filter((group) => group.bypassReview)).toEqual([
      expect.objectContaining({ code: 'REGION_KALUGA', name: 'Калужская область' }),
    ]);
  });
});
