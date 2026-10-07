import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export const POLICY_TIMEZONE = 'Europe/Moscow';
const DAY = 86_400_000;
const dayOf = (at: Date) => formatInTimeZone(at, POLICY_TIMEZONE, 'yyyy-MM-dd');
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const window = (day: string) => ({
  open: fromZonedTime(`${day}T08:00:00`, POLICY_TIMEZONE).getTime(),
  close: fromZonedTime(`${day}T17:00:00`, POLICY_TIMEZONE).getTime(),
  weekday: ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()),
});
export function nextWorkingInstant(at: Date): Date {
  let day = dayOf(at);
  for (;;) {
    const w = window(day);
    if (w.weekday && at.getTime() < w.close) return new Date(Math.max(at.getTime(), w.open));
    day = nextDay(day);
  }
}
export const policyWorkingHours = (at: Date) => nextWorkingInstant(at).getTime() === at.getTime();

/** Continuous working milliseconds: no rounding and no holiday calendar. */
export function addWorkingHours(at: Date, hours: number): Date {
  if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(at.getTime())) throw new Error('Invalid working duration');
  if (hours === 0) return new Date(at);
  let cursor = nextWorkingInstant(at).getTime(), remaining = hours * 3_600_000;
  for (;;) {
    const w = window(dayOf(new Date(cursor)));
    const available = w.close - cursor;
    if (remaining <= available) return new Date(cursor + remaining);
    remaining -= available;
    cursor = nextWorkingInstant(new Date(w.close)).getTime();
  }
}
export function workingMilliseconds(from: Date, to: Date): number {
  if (to <= from) return 0;
  let day = dayOf(from), sum = 0;
  while (day <= dayOf(to)) {
    const w = window(day);
    if (w.weekday) sum += Math.max(0, Math.min(to.getTime(), w.close) - Math.max(from.getTime(), w.open));
    day = nextDay(day);
  }
  return sum;
}
