import { IncidentStatus, type Incident } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  greetingText,
  myIncidentsText,
  registrationConfirmation,
  rulesText,
} from '../../src/bot/views/cards';

const incident = {
  publicCode: 'INC-20260904-0008',
  createdAt: new Date('2026-09-04T13:00:00.000Z'),
} as Incident;

describe('requester-facing copy', () => {
  it('does not disclose the internal response deadline', () => {
    const requesterCopy = [greetingText(), rulesText(), registrationConfirmation(incident)].join('\n');
    expect(requesterCopy).not.toMatch(/срок\s+ответа|не\s+позднее|72\s*час|3\s*(?:дня|дней)/i);
  });

  it('explains the current complete submission flow', () => {
    const greeting = greetingText();
    expect(greeting).toContain('чат-бот «Искра»');
    expect(greeting).toContain('ФИО и номер телефона');
    expect(greeting).toContain('сферу и место');
    expect(greeting).toContain('исправить любое поле');
    expect(greeting).toContain('«Мои обращения»');

    const rules = rulesText();
    expect(rules).toContain('ознакомьтесь с документами');
    expect(rules).toContain('действующий номер телефона');
    expect(rules).toContain('Если не уверены, нажмите «Не знаю»');
    expect(rules).toContain('Любое поле и фотографии можно исправить');
    expect(rules).toContain('Только после этого обращение будет зарегистрировано');
    expect(rules).toContain('итоговый ответ придёт в этот личный чат');
  });

  it('registration notice gives the number and status location without a deadline', () => {
    const notice = registrationConfirmation(incident);
    expect(notice).toContain('INC-20260904-0008');
    expect(notice).toContain('принято и направлено на рассмотрение');
    expect(notice).toContain('«Мои обращения»');
  });

  it('keeps the overdue marker internal in the requester incident list', () => {
    const list = myIncidentsText([
      {
        publicCode: 'INC-20260904-0008',
        status: IncidentStatus.IN_PROGRESS,
        isOverdue: true,
      } as Incident,
    ]);
    expect(list).toContain('В работе');
    expect(list).not.toContain('просрочено');
  });
});
