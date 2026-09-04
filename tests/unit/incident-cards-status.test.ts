import { IncidentStatus, ResponsibleGroupKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  distributionCard,
  distributionResolvedNotice,
  distributionWorkedNotice,
  sectorCard,
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

  it('does not show distribution markers in the receiving group card', () => {
    const text = sectorCard(incident, group);
    expect(text.startsWith('📥 НОВОЕ ОБРАЩЕНИЕ')).toBe(true);
    expect(text).not.toContain('РАСПРЕДЕЛЕНО');
  });

  it('marks the final distribution card as worked', () => {
    expect(distributionWorkedNotice(incident, group).startsWith('🟢 ОТРАБОТАНО')).toBe(true);
  });
});
