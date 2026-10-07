import { describe, it, expect } from 'vitest';
import { addWorkingHours, nextWorkingInstant, policyWorkingHours, workingMilliseconds } from '../../src/sla/working-time';
const date = (s: string) => new Date(`${s}+03:00`);
describe('fixed Moscow working time V1', () => {
  it.each([
    ['2026-10-09T16:00:00', 24, '2026-10-14T13:00:00'],
    ['2026-10-09T16:00:12.345', 24, '2026-10-14T13:00:12.345'],
    ['2026-10-09T17:00:00', 2, '2026-10-12T10:00:00'],
    ['2026-10-12T07:59:59', 2, '2026-10-12T10:00:00'],
    ['2026-10-12T08:00:00', 9, '2026-10-12T17:00:00'],
    ['2026-10-10T12:00:00', 2, '2026-10-12T10:00:00'],
    ['2026-10-30T16:30:00', 2, '2026-11-02T09:30:00'],
    ['2026-12-31T16:00:00', 2, '2027-01-01T09:00:00'],
    ['2026-10-12T12:00:00', 2, '2026-10-12T14:00:00'],
  ])('%s + %s hours = %s', (from, hours, to) => {
    expect(addWorkingHours(date(from), hours)).toEqual(date(to));
    expect(workingMilliseconds(date(from), date(to))).toBe(hours * 3_600_000);
  });
  it('includes opening and excludes closing, preserving milliseconds', () => {
    expect(policyWorkingHours(date('2026-10-12T08:00:00'))).toBe(true);
    expect(policyWorkingHours(date('2026-10-12T16:59:59.999'))).toBe(true);
    expect(policyWorkingHours(date('2026-10-12T17:00:00'))).toBe(false);
    expect(nextWorkingInstant(date('2026-10-09T17:00:00'))).toEqual(date('2026-10-12T08:00:00'));
    expect(workingMilliseconds(date('2026-10-09T16:59:59.123'), date('2026-10-12T08:00:01.123'))).toBe(2000);
  });
});
