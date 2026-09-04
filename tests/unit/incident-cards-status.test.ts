import { IncidentStatus, ResponsibleGroupKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  distributionCard,
  distributionResolvedNotice,
  sectorCard,
  sectorWorkedNotice,
} from '../../src/bot/views/cards';
import type { IncidentWithRelations } from '../../src/incidents/incident.repository';

const incident = {
  id: 'incident-1',
  publicCode: 'INC-20260904-0006',
  createdAt: new Date('2026-09-04T11:00:00.000Z'),
  deadlineAt: new Date('2026-09-07T11:00:00.000Z'),
  requesterName: 'Иван Иванов',
  requesterMaxUserId: 1n,
  text: 'Не работает фонарь.',
  status: IncidentStatus.DISTRIBUTION,
  problemMunicipalityName: 'Жуковский округ',
  problemLocality: null,
  attachments: [],
  answers: [],
  userSelectedCategory: null,
  assignedGroup: null,
  currentResponder: null,
  assignedBy: null,
  approvedBy: null,
} as unknown as IncidentWithRelations;

const group = {
  id: 'group-1',
  code: 'ZHUKOVSKY',
  name: 'Жуковский район',
  kind: ResponsibleGroupKind.LOCAL_GOVERNMENT,
} as Parameters<typeof distributionResolvedNotice>[1];

describe('staff card status markers', () => {
  it('marks a new distribution card as not distributed', () => {
    expect(distributionCard(incident).startsWith('🔴 НЕ РАСПРЕДЕЛЕНО')).toBe(true);
  });

  it('marks the closed distribution card as distributed', () => {
    expect(distributionResolvedNotice(incident, group, 'Диспетчер').startsWith('🟡 РАСПРЕДЕЛЕНО')).toBe(true);
  });

  it('marks the receiving group card as distributed', () => {
    expect(sectorCard(incident, group).startsWith('🟡 РАСПРЕДЕЛЕНО')).toBe(true);
  });

  it('marks a closed sector card as worked', () => {
    const text = sectorWorkedNotice(incident, group, 'Ответственный', 'review');
    expect(text.startsWith('🟢 ОТРАБОТАНО')).toBe(true);
    expect(text).toContain('Ответ передан на согласование.');
  });
});
