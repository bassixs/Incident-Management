import { ResponsibleGroupKind, type ResponsibleGroup } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_PAGE_SIZE,
  assignmentBranchKeyboard,
  assignmentGroupKeyboard,
  assignmentPageCount,
} from '../../src/bot/keyboards';
import { parseCallbackPayload } from '../../src/max/callback-payload';

const INCIDENT_ID = '550e8400-e29b-41d4-a716-446655440000';

function group(
  index: number,
  kind: ResponsibleGroupKind = ResponsibleGroupKind.LOCAL_GOVERNMENT,
): ResponsibleGroup {
  return {
    id: `11111111-2222-3333-4444-${String(index).padStart(12, '0')}`,
    code: `G${index}`,
    name: `Группа ${index}`,
    kind,
    maxChatId: BigInt(-1000 - index),
    municipalityCode: `AREA_${index}`,
    authorityName: null,
    answerTemplate: null,
    bypassReview: false,
    isActive: true,
    sortOrder: index,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('новое распределение по ответственным группам', () => {
  it('shows exactly three routing choices before cancellation', () => {
    const regional = { ...group(99, ResponsibleGroupKind.REGIONAL), name: 'Калужская область' };
    const labels = assignmentBranchKeyboard(INCIDENT_ID, regional, null)
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual([
      'Калужская область',
      'Органы местного самоуправления',
      'Органы исполнительной власти',
      'Отмена',
    ]);
    const first = assignmentBranchKeyboard(INCIDENT_ID, regional, null)[0]![0]! as { payload: string };
    expect(parseCallbackPayload(first.payload)).toMatchObject({ action: 'assign-branch', argument: 'regional' });
  });

  it('marks Kaluga Region as recommended for a region-wide question', () => {
    const regional = { ...group(99, ResponsibleGroupKind.REGIONAL), name: 'Калужская область' };
    expect(assignmentBranchKeyboard(INCIDENT_ID, regional, regional)[0]![0]!.text).toContain('рекомендуется');
  });

  it('places a recommended municipality first without duplicating it', () => {
    const groups = Array.from({ length: 26 }, (_, index) => group(index));
    const recommended = groups[18]!;
    const rows = assignmentGroupKeyboard(INCIDENT_ID, 'local', groups, 0, recommended);
    const groupLabels = rows.flat().map((button) => button.text).filter((text) => text.startsWith('Группа') || text.startsWith('⭐'));
    expect(groupLabels).toHaveLength(ASSIGNMENT_PAGE_SIZE);
    expect(groupLabels[0]).toBe(`⭐ ${recommended.name} — рекомендуется`);
    expect(groupLabels.filter((label) => label.includes(recommended.name))).toHaveLength(1);
    expect(assignmentPageCount(groups.length)).toBe(5);
  });

  it('emits a group assignment callback understood by the router', () => {
    const target = group(3);
    const button = assignmentGroupKeyboard(INCIDENT_ID, 'local', [target], 0)[0]![0]! as {
      payload: string;
    };
    expect(parseCallbackPayload(button.payload)).toEqual({
      kind: 'incident',
      action: 'assign-group',
      incidentId: INCIDENT_ID,
      argument: target.id,
    });
  });

  it('keeps branch and page in navigation callbacks', () => {
    const groups = Array.from({ length: 10 }, (_, index) => group(index));
    const next = assignmentGroupKeyboard(INCIDENT_ID, 'local', groups, 0)
      .flat()
      .find((button) => button.text === 'Вперёд ➡️') as { payload: string };
    expect(parseCallbackPayload(next.payload)).toEqual({
      kind: 'incident',
      action: 'assign-page',
      incidentId: INCIDENT_ID,
      argument: 'local~1',
    });
  });
});
