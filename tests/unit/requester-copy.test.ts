import { IncidentStatus, type Incident } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  greetingText,
  incidentPromptText,
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
    expect(greeting).toContain('сохранит');
    expect(greeting).toContain('сферу и место');
    expect(greeting).toContain('исправить любое поле');
    expect(greeting).toContain('«Мои обращения»');

    const rules = rulesText();
    expect(rules).toContain('ознакомьтесь с документами');
    expect(rules).toContain('действующий номер телефона');
    expect(rules).toContain('Поделиться контактом');
    expect(rules).toContain('следующих обращений');
    expect(rules).toContain('Если не уверены, нажмите «Иное»');
    expect(rules).toContain('Любое поле и фотографии можно исправить');
    expect(rules).toContain('Только после этого обращение будет зарегистрировано');
    expect(rules).toContain('итоговый ответ придёт в этот личный чат');
  });

  it('includes the customer notice and describes explicit consent rather than automatic consent', () => {
    expect(greetingText()).toContain('органам исполнительной власти и местного самоуправления');
    expect(greetingText()).toContain('отдельно подтвердите согласие');
    expect(greetingText()).toContain('их передачу в органы');
    for (const text of [greetingText(), rulesText()]) {
      expect(text).toContain('поданными через чат-бот «Искра»');
      expect(text).toContain('не применяются положения Федерального закона');
      expect(text).toContain('02.05.2006');
      expect(text).toContain('59-ФЗ');
    }
    expect(rulesText()).toContain('Подача сообщения через бот означает согласие с данными правилами');
    expect(rulesText()).toContain('5. Текст обращения или сообщения не позволяет определить суть предложения, заявления или жалобы.');
    expect(rulesText()).toContain('8. В сообщении отсутствует адрес проблемы.');
    expect(rulesText()).toContain('при этом в сообщении не приводятся новые обстоятельства.');
    expect(rulesText()).toContain('7. Сообщения, несущие урон чести и достоинству других граждан.');
    expect(incidentPromptText()).toContain('адрес проблемы');
    expect(incidentPromptText()).toContain('точное место, если адреса нет');
    // Keep the rules and the menu keyboard in one MAX message.
    expect([...rulesText()].length).toBeLessThanOrEqual(3800);
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
  it.each(Object.values(IncidentStatus))('shows only two public statuses for %s', status => {
    const text = myIncidentsText([{ publicCode: 'INC-TEST', status, isOverdue: true } as Incident]);
    expect(text.split('\n').filter(Boolean)).toEqual(['Ваши последние обращения:', 'INC-TEST', ['RESOLVED', 'REJECTED'].includes(status) ? 'Закрыто' : 'В работе']);
  });
});
