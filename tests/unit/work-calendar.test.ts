import { expect, it } from 'vitest';
import { computeDeadline } from '../../src/utils/datetime';
import { incidentWorkday, workingHours } from '../../src/utils/work-calendar';
import { loadConfig } from '../../src/config';

it.each([
  ['2026-09-11T13:59:59Z', '2026-09-15T14:00:00.000Z'], // Friday 16:59 -> Tuesday 17:00.
  ['2026-09-11T14:00:00Z', '2026-09-16T14:00:00.000Z'],
  ['2026-09-11T04:00:00Z', '2026-09-15T14:00:00.000Z'],
  ['2026-09-12T09:00:00Z', '2026-09-16T14:00:00.000Z'],
  ['2026-09-13T23:00:00Z', '2026-09-16T14:00:00.000Z'], // Monday 02:00 Moscow.
  ['2026-09-07T05:00:00Z', '2026-09-09T14:00:00.000Z'],
  ['2026-09-09T14:00:00Z', '2026-09-14T14:00:00.000Z'],
  ['2026-09-30T10:00:00Z', '2026-10-02T14:00:00.000Z'],
  ['2027-12-31T10:00:00Z', '2028-01-04T14:00:00.000Z'], // Calendar is Mon-Fri, without a holiday table.
])('deadline for %s is %s', (arrival, expected) => {
  expect(computeDeadline(new Date(arrival), 3).toISOString()).toBe(expected);
});

it('starts reminder days at opening after a weekend, even when fewer than 24 hours of work have elapsed', () => {
  const arrival = new Date('2026-09-11T13:59:59Z');
  expect(incidentWorkday(arrival, 2).start.toISOString()).toBe('2026-09-14T05:00:00.000Z');
  expect(incidentWorkday(arrival, 3).start.toISOString()).toBe('2026-09-15T05:00:00.000Z');
  expect(workingHours(new Date('2026-09-14T04:59:59Z'))).toBe(false);
  expect(workingHours(new Date('2026-09-14T05:00:00Z'))).toBe(true);
});

it('rejects a reversed or empty work window', () => {
  for (const end of ['07:00', '08:00']) {
    expect(() => loadConfig({ ...process.env, WORKDAY_START: '08:00', WORKDAY_END: end })).toThrow('WORKDAY_END');
  }
});
