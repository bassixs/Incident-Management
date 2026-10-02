import { readFileSync } from 'node:fs';
import { IncidentStatus, type Incident } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE, PRIVACY_REJECTION } from '../../src/privacy/personal-data';
import { CONTACT_REJECTION, OPTIONAL_PHONE_OFFER } from '../../src/privacy/optional-contact';
import { REJECTION_REASONS } from '../../src/distribution/rejection-reasons';

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
  it('matches the approved greeting and rules exactly', () => {
    expect(greetingText()).toBe(readFileSync('tests/fixtures/resident-greeting.txt', 'utf8').replace(/\r\n/g, '\n').trimEnd());
    expect(rulesText()).toBe(readFileSync('tests/fixtures/resident-rules.txt', 'utf8').replace(/\r\n/g, '\n').trimEnd());
  });
  it('describes manual optional phone and visibility in full work cards', () => {
    expect(OPTIONAL_PHONE_OFFER).toBe('Для более оперативной обработки можно поделиться телефоном. Это необязательно.');
    expect(rulesText()).not.toContain(PRIVACY_NOTICE);
    expect(rulesText()).toContain('Телефон для связи разрешён.');
    expect(PRIVACY_NOTICE).toContain('Номер виден участникам рабочих чатов в карточке сообщения');
    expect(PRIVACY_NOTICE).toContain('Проверяется формат, а не принадлежность номера.');
    expect(PRIVACY_NOTICE).toContain('Отдельное подтверждение проверки перед распределением не требуется.');
    expect(PRIVACY_REJECTION).toBe('Сообщение не принято: обнаружены возможные запрещённые персональные данные. Уберите ФИО, паспортные данные, СНИЛС, банковские реквизиты, адреса электронной почты и другие запрещённые личные сведения. Телефон для связи разрешён. Исправьте текст и отправьте заново.');
    expect(REJECTION_REASONS.find(r => r.id === '9')?.reason).toContain('Телефон для связи разрешён.');
    expect(CONTACT_REJECTION).toBe('Системные карточки контакта больше не используются. На итоговой карточке нажмите «📞 Поделиться контактом» и введите номер вручную. Сообщение не отправлено.');
    expect(CONTACT_REJECTION).not.toContain('персональные данные');
  });
  it('does not disclose the internal response deadline', () => {
    const requesterCopy = [greetingText(), rulesText(), registrationConfirmation(incident)].join('\n');
    expect(requesterCopy).not.toMatch(/срок\s+ответа|не\s+позднее|72\s*час|3\s*(?:дня|дней)/i);
  });

  it('explains the current complete submission flow', () => {
    const greeting = greetingText();
    expect(greeting).toContain('чат-бот «На связи_регион40»');
    expect(greeting).not.toContain('Сохраняются ID в MAX');
    expect(greeting).toContain('сферу и место');
    expect(greeting).toContain('Проверьте информацию, при необходимости исправьте');
    expect(greeting).toContain('«Мои сообщения»');

    const rules = rulesText();
    expect(rules).toContain('Нажмите «Создать сообщение»');
    expect(rules).not.toContain('ФИО не запрашивается');
    expect(rules).toContain('9. Текст или фотографии');
    expect(rules).toContain('Если не уверены, нажмите «Иное»');
    expect(rules).toContain('Любое поле и фотографии можно исправить');
    expect(rules).toContain('Только после этого сообщение будет принято в работу');
    expect(rules).toContain('итоговый ответ придёт в этот личный чат');
  });

  it('keeps the approved legal notice and removes the third greeting paragraph', () => {
    expect(greetingText()).toContain('органам исполнительной власти и местного самоуправления');
    expect(greetingText()).not.toContain('ФИО не запрашивается');
    expect(rulesText()).not.toContain('служебные сведения о его обработке');
    for (const text of [greetingText(), rulesText()]) {
      expect(text).toContain('Чат-бот «На связи_регион40»');
      expect(text).toContain('дополнительный канал обратной связи');
      expect(text).toContain('Платформой обратной связи');
      expect(text).toContain('02.05.2006');
      expect(text).toContain('59-ФЗ');
    }
    expect(rulesText()).not.toContain('ФИО не запрашивается');
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
