import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getConfig, type AppConfig } from '../config';

export const WORK_TIMEZONE = 'Europe/Moscow';
type Schedule = Pick<AppConfig, 'WORKDAY_START' | 'WORKDAY_END'>;
const nextDate = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const weekday = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const instant = (day: string, time: string) => fromZonedTime(`${day}T${time}:00`, WORK_TIMEZONE);

/** Weekdays only, including the opening instant and excluding closing time. */
export function workingHours(now: Date, config: Schedule = getConfig()): boolean {
  const day = formatInTimeZone(now, WORK_TIMEZONE, 'yyyy-MM-dd');
  return weekday(day) && now >= instant(day, config.WORKDAY_START) && now < instant(day, config.WORKDAY_END);
}

/** The arrival date counts as day one until closing, even before opening.
 * After closing and on weekends, day one is the next weekday. */
export function incidentWorkday(createdAt: Date, ordinal: number, config: Schedule = getConfig()): { start: Date; end: Date } {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('Workday ordinal must be a positive integer');
  let day = formatInTimeZone(createdAt, WORK_TIMEZONE, 'yyyy-MM-dd');
  if (createdAt >= instant(day, config.WORKDAY_END)) day = nextDate(day);
  while (!weekday(day)) day = nextDate(day);
  for (let n = 1; n < ordinal; n++) {
    day = nextDate(day);
    while (!weekday(day)) day = nextDate(day);
  }
  return { start: instant(day, config.WORKDAY_START), end: instant(day, config.WORKDAY_END) };
}
