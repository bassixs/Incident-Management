import { describe, expect, it } from 'vitest';

import {
  computeDeadline,
  dayBoundaries,
  formatIsoDay,
  formatDateTime,
  hoursUntil,
} from '../../src/utils/datetime';

describe('SLA arithmetic', () => {
  it('sets a Sunday arrival deadline to Wednesday at 17:00 Moscow', () => {
    const createdAt = new Date('2026-08-23T15:42:00.000Z');
    const deadline = computeDeadline(createdAt, 3);
    expect(deadline.toISOString()).toBe('2026-08-26T14:00:00.000Z');
  });

  it('is a pure function of createdAt, so recomputation cannot drift', () => {
    const createdAt = new Date('2026-08-23T15:42:00.000Z');
    expect(computeDeadline(createdAt, 3).getTime()).toBe(computeDeadline(createdAt, 3).getTime());
  });

  it('reports remaining hours for the warning thresholds', () => {
    const now = new Date('2026-08-26T09:42:00.000Z');
    const deadline = new Date('2026-08-26T15:42:00.000Z');
    expect(hoursUntil(deadline, now)).toBeCloseTo(6, 6);
    expect(hoursUntil(new Date('2026-08-26T03:42:00.000Z'), now)).toBeLessThan(0);
  });
});

describe('calendar days in APP_TIMEZONE', () => {
  it('bounds a Moscow day at 21:00Z the previous day', () => {
    const { start, end } = dayBoundaries(new Date('2026-08-23T15:42:00.000Z'), 'Europe/Moscow');
    expect(start.toISOString()).toBe('2026-08-22T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-23T21:00:00.000Z');
  });

  it('puts a late-evening UTC instant into the next Moscow day', () => {
    // 23:30Z on the 23rd is 02:30 on the 24th in Moscow.
    const { start } = dayBoundaries(new Date('2026-08-23T23:30:00.000Z'), 'Europe/Moscow');
    expect(start.toISOString()).toBe('2026-08-23T21:00:00.000Z');
    expect(formatIsoDay(new Date('2026-08-23T23:30:00.000Z'), 'Europe/Moscow')).toBe('2026-08-24');
  });

  it('formats operator-facing timestamps in the configured zone', () => {
    expect(formatDateTime(new Date('2026-08-23T15:42:00.000Z'), 'Europe/Moscow')).toBe('23.08.2026 18:42');
  });
});
