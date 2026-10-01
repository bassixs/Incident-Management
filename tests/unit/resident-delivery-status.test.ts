import { expect, it } from 'vitest';
import { myIncidentsText } from '../../src/bot/views/cards';

it('requires delivery of the greatest answer version, not any historical answer', () => {
  const incident = { publicCode: 'INC-000164', status: 'RESOLVED', answers: [
    { version: 2, deliveredAt: null }, { version: 1, deliveredAt: new Date() },
  ] };
  expect(myIncidentsText([incident as never])).toContain('Ответ отправляется');
  incident.answers[0]!.deliveredAt = new Date();
  expect(myIncidentsText([incident as never])).toContain('Закрыто');
  incident.status = 'WAITING_REVIEW';
  expect(myIncidentsText([incident as never])).toContain('В работе');
  incident.status = 'REJECTED';
  expect(myIncidentsText([incident as never])).toContain('Отклонено');
});

it('does not infer delivery when a resolved incident has no answer evidence', () => {
  expect(myIncidentsText([{ publicCode: 'INC-000165', status: 'RESOLVED' } as never])).toContain('Ответ отправляется');
});
