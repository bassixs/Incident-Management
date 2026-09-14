import { IncidentStatus, ResponsibleGroupKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  distributionCard,
  distributionResolvedNotice,
  distributionWorkedNotice,
  distributionStatus,
  incidentLookupCard,
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
    expect(distributionCard(incident)).not.toContain('🟢');
  });

  it('marks the closed distribution card as distributed', () => {
    expect(distributionResolvedNotice(incident, group, 'Диспетчер').startsWith('🟢 РАСПРЕДЕЛЕНО')).toBe(true);
  });

  it('marks a newly assigned sector card as available', () => {
    const text = sectorCard({ ...incident, status: IncidentStatus.ASSIGNED }, group);
    expect(text.startsWith('🔴 СВОБОДНОЕ')).toBe(true);
    expect(text).not.toContain('РАСПРЕДЕЛЕНО');
  });

  it.each([
    [IncidentStatus.IN_PROGRESS, '🟡 В РАБОТЕ'],
    [IncidentStatus.WAITING_REVIEW, '🔵 НА СОГЛАСОВАНИИ'],
    [IncidentStatus.REVISION_REQUIRED, '🟠 НА ДОРАБОТКЕ'],
    [IncidentStatus.RESOLVED, '⏳ ОЖИДАЕТ ДОСТАВКИ'],
  ])('shows the sector workflow stage %s', (status, marker) => {
    const text = sectorCard({ ...incident, status }, group);
    expect(text.startsWith(marker)).toBe(true);
    expect(text).not.toContain('НОВОЕ ОБРАЩЕНИЕ');
    expect(text).toContain(incident.text);
    expect(distributionStatus({ status })).toBe('🟢 РАСПРЕДЕЛЕНО');
    expect(incidentLookupCard({ ...incident, status }, undefined, true)).toContain('Статус:\n🟢 РАСПРЕДЕЛЕНО');
    expect(incidentLookupCard({ ...incident, status }, undefined, true)).not.toContain(status);
  });

  it('only marks the latest delivered answer as worked', () => {
    const answered = { ...incident, status: IncidentStatus.RESOLVED,
      answers: [{ deliveredAt: new Date() }] } as IncidentWithRelations;
    expect(sectorCard(answered, group).startsWith('🟢 ОТРАБОТАНО')).toBe(true);
    answered.answers.push({ deliveredAt: null } as IncidentWithRelations['answers'][number]);
    expect(sectorCard(answered, group).startsWith('⏳ ОЖИДАЕТ ДОСТАВКИ')).toBe(true);
  });

  it('keeps the responder name without calling a closed incident in progress', () => {
    const closed = { ...incident, status: IncidentStatus.RESOLVED,
      currentResponder: { displayName: 'Исполнитель' }, answers: [{ deliveredAt: new Date() }] } as IncidentWithRelations;
    const text = sectorCard(closed, group);
    expect(text).toContain('👤 Исполнитель:\nИсполнитель');
    expect(text).not.toContain('В работе:');
  });

  it('keeps the final distribution card distributed without delivery indicators', () => {
    expect(distributionWorkedNotice(incident, group).startsWith('🟢 РАСПРЕДЕЛЕНО')).toBe(true);
    expect(distributionWorkedNotice(incident, group)).not.toContain('Ответ отправлен');
    expect(distributionStatus({ status: 'REJECTED' })).toBe('🔴 НЕ РАСПРЕДЕЛЕНО');
  });
});
