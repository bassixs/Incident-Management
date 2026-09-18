import type { Incident, IncidentAnswer, ResponsibleGroup } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { finalAnswerToRequester, reviewCard } from '../../src/bot/views/cards';
import type { IncidentWithRelations } from '../../src/incidents/incident.repository';
import { answerSignature } from '../../src/responsible-groups/answer-signature';
import { RESPONSIBLE_GROUPS } from '../../src/responsible-groups/catalog';

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
const SIGNATURE = 'Ответ подготовлен Министерством транспорта Калужской области.';

/**
 * The signature is derived from the сфера, never typed by a responder, so a
 * missing authority must degrade to "no signature" rather than to something
 * nonsensical like «Ответ подготовлен Дорогами».
 */
describe('подпись ведомства в ответе жителю', () => {
  it('добавляет подпись, когда ведомство задано', () => {
    const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, AUTHORITY);
    expect(text).toContain(SIGNATURE);
  });

  it('ставит подпись после текста ответа и до даты', () => {
    const text = finalAnswerToRequester(incident, answer, ANSWERED_AT, AUTHORITY);
    const answerAt = text.indexOf(answer.text);
    const signatureAt = text.indexOf(SIGNATURE);
    const dateAt = text.indexOf('Дата ответа:');
    expect(answerAt).toBeLessThan(signatureAt);
    expect(signatureAt).toBeLessThan(dateAt);
  });

  it('не выводит блок подписи, если ведомство не задано', () => {
    for (const missing of [undefined, null, '', '   ']) {
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
  const withGroup = (authorityName: string | null): IncidentWithRelations =>
    ({ ...incident, attachments: [], answers: [] }) as unknown as IncidentWithRelations;

  const group = (authorityName: string | null): ResponsibleGroup =>
    ({ name: 'Министерство транспорта', authorityName }) as ResponsibleGroup;

  const answerWithAttachments = { ...answer, attachments: [] } as IncidentAnswer & {
    attachments: Array<{ type: string }>;
  };

  it('показывает согласующему, за чьей подписью уйдёт ответ', () => {
    const card = reviewCard(withGroup(AUTHORITY), answerWithAttachments, group(AUTHORITY));
    expect(card).toContain('Подпись в ответе жителю:');
    expect(card).toContain(SIGNATURE);
  });

  it('предупреждает согласующего, если ведомство не задано', () => {
    const card = reviewCard(withGroup(null), answerWithAttachments, group(null));
    expect(card).toContain('Ведомство для подписи не задано');
  });
});

describe('полные названия всех исполнителей', () => {
  it.each([
    ['Министерство транспорта', 'Министерством транспорта Калужской области'],
    ['Министерство строительства и ЖКХ', 'Министерством строительства и жилищно-коммунального хозяйства Калужской области'],
    ['Министерство экономического развития', 'Министерством экономического развития и промышленности Калужской области'],
    ['Администрация Боровского округа', 'Администрацией Боровского округа'],
    ['Администрация Куйбышевского района', 'Администрацией Куйбышевского района'],
    ['Администрация города Калуги', 'Администрацией города Калуги'],
    ['Администрация города Обнинска', 'Администрацией города Обнинска'],
    ['ГЖИ', 'Государственной жилищной инспекцией Калужской области'],
    ['УАТК', 'Управлением административно-технического контроля Калужской области'],
    ['ЗАГС', 'Управлением записи актов гражданского состояния Калужской области'],
    ['Комитет ветеринарии', 'Комитетом ветеринарии при Правительстве Калужской области'],
    ['Госстройнадзор', 'Инспекцией государственного строительного надзора Калужской области'],
    ['Калужская область', 'Администрацией Губернатора Калужской области'],
    ['Администрация Губернатора', 'Администрацией Губернатора Калужской области'],
    ['Фонд защитников Отечества', 'Фондом защитников Отечества'],
    ['Социальный фонд', 'Социальным фондом'],
  ])('%s → %s', (name, expected) => {
    expect(answerSignature(name)).toBe(`Ответ подготовлен ${expected}.`);
    expect(answerSignature(expected)).toBe(`Ответ подготовлен ${expected}.`);
  });

  it.each(RESPONSIBLE_GROUPS)('$code: одинаковая полная подпись в согласовании и ответе', group => {
    const authorityName = group.authorityName ?? group.name;
    const signature = answerSignature(authorityName)!;
    expect(signature).toMatch(/^Ответ подготовлен (Администрацией|Министерством|Государственной жилищной инспекцией|Управлением|Комитетом|Инспекцией|Фондом|Социальным фондом)( .+)?\.$/);
    expect(signature).not.toMatch(/ГЖИ|УАТК|ЗАГС|ЖКХ|Госстройнадзор/);
    expect(finalAnswerToRequester(incident, answer, ANSWERED_AT, authorityName)).toContain(signature);
    expect(reviewCard({ ...incident, attachments: [], answers: [] } as unknown as IncidentWithRelations,
      { ...answer, attachments: [] }, { ...group, authorityName } as ResponsibleGroup)).toContain(signature);
  });

  it('сохраняет вручную заданную неизвестную подпись без догадок о склонении', () => {
    expect(answerSignature('Экспертная служба')).toBe('Ответ подготовлен:\nЭкспертная служба');
  });
});
