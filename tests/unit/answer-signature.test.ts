import type { Category, Incident, IncidentAnswer } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { finalAnswerToRequester, reviewCard } from '../../src/bot/views/cards';
import type { IncidentWithRelations } from '../../src/incidents/incident.repository';

const ANSWERED_AT = new Date('2026-08-30T09:00:00.000Z');

const incident = {
  publicCode: 'INC-20260830-0007',
  text: 'На перекрёстке Мира и Победы не работает светофор.',
  createdAt: new Date('2026-08-28T09:00:00.000Z'),
  deadlineAt: new Date('2026-08-31T09:00:00.000Z'),
  isOverdue: false,
} as Incident;

const answer = {
  version: 1,
  text: 'Светофор восстановлен, выполнена замена контроллера.',
} as IncidentAnswer;

const AUTHORITY = 'Министерство транспорта Калужской области';

/**
 * The signature is derived from the сфера, never typed by a responder, so a
 * missing authority must degrade to "no signature" rather than to something
 * nonsensical like «Ответ подготовлен Дорогами».
 */
describe('подпись ведомства в ответе жителю', () => {
  it('добавляет подпись, когда ведомство задано', () => {
    const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, AUTHORITY);
    expect(text).toContain('Ответ подготовлен:');
    expect(text).toContain(AUTHORITY);
  });

  it('ставит подпись после текста ответа и до даты', () => {
    const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, AUTHORITY);
    const answerAt = text.indexOf(answer.text);
    const signatureAt = text.indexOf(AUTHORITY);
    const dateAt = text.indexOf('Дата ответа:');
    expect(answerAt).toBeLessThan(signatureAt);
    expect(signatureAt).toBeLessThan(dateAt);
  });

  it('не выводит блок подписи, если ведомство не задано', () => {
    for (const missing of [undefined, null, '']) {
      const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, missing);
      expect(text).not.toContain('Ответ подготовлен');
      // Остальная часть ответа не должна пострадать.
      expect(text).toContain(answer.text);
      expect(text).toContain(incident.publicCode);
      expect(text).toContain('Дата ответа:');
    }
  });

  it('не подставляет вместо ведомства название темы', () => {
    const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, null);
    expect(text).not.toContain('Дороги');
  });
});

describe('подпись в карточке согласования', () => {
  const withCategory = (authorityName: string | null): IncidentWithRelations =>
    ({ ...incident, attachments: [], answers: [] }) as unknown as IncidentWithRelations;

  const category = (authorityName: string | null): Category =>
    ({ name: 'Дороги', authorityName }) as Category;

  const answerWithAttachments = { ...answer, attachments: [] } as IncidentAnswer & {
    attachments: Array<{ type: string }>;
  };

  it('показывает согласующему, за чьей подписью уйдёт ответ', () => {
    const card = reviewCard(withCategory(AUTHORITY), answerWithAttachments, category(AUTHORITY));
    expect(card).toContain('Уйдёт за подписью:');
    expect(card).toContain(AUTHORITY);
  });

  it('предупреждает согласующего, если ведомство не задано', () => {
    const card = reviewCard(withCategory(null), answerWithAttachments, category(null));
    expect(card).toContain('Ведомство для подписи не задано');
  });
});
