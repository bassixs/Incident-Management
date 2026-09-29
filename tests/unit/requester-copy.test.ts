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
    expect(greeting).toContain('чат-бот «На связи_регион40»');
    expect(greeting).not.toContain('Сохраняются ID в MAX');
    expect(greeting).toContain('сферу и место');
    expect(greeting).toContain('исправить любое поле');
    expect(greeting).toContain('«Мои сообщения»');

    const rules = rulesText();
    expect(rules).toContain('Нажмите «Создать сообщение»');
    expect(rules).toContain('ФИО не запрашивается');
    expect(rules).toContain('9. Текст или фотографии');
    expect(rules).toContain('проверку сотрудником');
    expect(rules).toContain('Если не уверены, нажмите «Иное»');
    expect(rules).toContain('Любое поле и фотографии можно исправить');
    expect(rules).toContain('Только после этого сообщение будет зарегистрировано');
    expect(rules).toContain('итоговый ответ придёт в этот личный чат');
  });

  it('keeps the approved legal notice and removes the third greeting paragraph', () => {
    expect(greetingText()).toContain('органам исполнительной власти и местного самоуправления');
    expect(greetingText()).not.toContain('ФИО не запрашивается');
    expect(rulesText()).toContain('служебные сведения о его обработке');
    for (const text of [greetingText(), rulesText()]) {
      expect(text).toContain('Чат-бот «На связи_регион40»');
      expect(text).toContain('дополнительный канал обратной связи');
      expect(text).toContain('Ваши права, предусмотренные законом, сохраняются');
      expect(text).toContain('02.05.2006');
      expect(text).toContain('59-ФЗ');
    }
    expect(rulesText()).toContain('ФИО не запрашивается');
    expect(rulesText()).toContain('5. Текст сообщения не позволяет определить суть предложения, заявления или жалобы.');
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
    expect(notice).toContain('«Мои сообщения»');
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
    expect(text.split('\n').filter(Boolean)).toEqual(['Ваши последние сообщения:', 'INC-TEST', ['RESOLVED', 'REJECTED'].includes(status) ? 'Закрыто' : 'В работе']);
  });
});
