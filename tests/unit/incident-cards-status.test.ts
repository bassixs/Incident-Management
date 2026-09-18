import { IncidentStatus, ResponsibleGroupKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  distributionCard,
  distributionResolvedNotice,
  distributionWorkedNotice,
  distributionStatus,
  incidentLookupCard,
  sectorCard,
  reviewCard,
  revisionCard,
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

describe('review card revision history', () => {
  const answer = (version: number, text: string, revisionReason: string | null = null) =>
    ({ version, text, revisionReason, attachments: [] }) as unknown as IncidentWithRelations['answers'][number];

  it('does not show a revision history on the first review or a correction without a return', () => {
    const first = answer(1, 'Исходный ответ'); const corrected = answer(2, 'Правка куратора');
    const i = { ...incident, answers: [first, corrected] };
    expect(reviewCard(i, first, group)).not.toContain('ИСТОРИЯ ДОРАБОТКИ');
    expect(reviewCard(i, corrected, group)).not.toContain('Исходный ответ');
    expect(reviewCard(i, corrected, group)).toContain('Ответ:\nПравка куратора');
  });

  it('orders only earlier versions, pairs remarks with their text and leaves the input unchanged', () => {
    const first = answer(1, 'Первый текст', 'Первое замечание');
    const second = answer(2, 'Второй текст', 'Второе замечание');
    const current = answer(3, 'Третий текст'); const future = answer(4, 'Будущий текст');
    const i = { ...incident, answers: [future, second, current, first], revisionReason: 'Чужое последнее замечание' };
    const text = reviewCard(i, current, group);
    expect(text).toContain('Первоначальный ответ (версия 1):\nПервый текст\n\n↩️ Причина доработки версии 1:\nПервое замечание');
    expect(text).toContain('Предыдущий ответ (версия 2):\nВторой текст\n\n↩️ Причина доработки версии 2:\nВторое замечание');
    expect(text.indexOf('Первый текст')).toBeLessThan(text.indexOf('Второй текст'));
    expect(text.indexOf('Второй текст')).toBeLessThan(text.indexOf('Третий текст'));
    expect(text).not.toContain('Будущий текст');
    expect(text).not.toContain('Чужое последнее замечание');
    expect(i.answers.map(a => a.version)).toEqual([4, 2, 3, 1]);
  });
});

describe('staff card status markers', () => {
  it('hides the internal answer deadline from all executor cards but retains it for internal lookup', () => {
    const row = { ...incident, status: IncidentStatus.IN_PROGRESS, isOverdue: true };
    for (const text of [sectorCard(row, group), revisionCard(row, 1, 'Уточните адрес'), incidentLookupCard(row, undefined, false, false)]) {
      expect(text).not.toMatch(/срок|просроч|07\.09\.2026/i);
    }
    expect(incidentLookupCard(row)).toContain('Срок ответа:');
    expect(row.deadlineAt).toEqual(incident.deadlineAt);
  });
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
