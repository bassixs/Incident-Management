import { addHours } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

import { getConfig } from '../config';

function tz(timeZone?: string): string {
  return timeZone ?? getConfig().APP_TIMEZONE;
}

/** `23.08.2026 18:42` — the format used in every operator-facing card. */
export function formatDateTime(date: Date, timeZone?: string): string {
  return formatInTimeZone(date, tz(timeZone), 'dd.MM.yyyy HH:mm');
}

/** `23.08.2026` — used where the time of day carries no meaning. */
export function formatDate(date: Date, timeZone?: string): string {
  return formatInTimeZone(date, tz(timeZone), 'dd.MM.yyyy');
}

/** `20260823` — the day component of publicCode, in the configured timezone. */
export function formatCounterDay(date: Date, timeZone?: string): string {
  return formatInTimeZone(date, tz(timeZone), 'yyyyMMdd');
}

/** `2026-08-23` — ISO calendar day in the configured timezone. */
export function formatIsoDay(date: Date, timeZone?: string): string {
  return formatInTimeZone(date, tz(timeZone), 'yyyy-MM-dd');
}

/**
 * Calendar-day bounds of `date` expressed as absolute instants.
 * The daily incident limit is defined per calendar day in APP_TIMEZONE, so the
 * boundaries move with DST rather than being a fixed 24h window.
 */
export function dayBoundaries(date: Date, timeZone?: string): { start: Date; end: Date } {
  const zone = tz(timeZone);
  const zoned = toZonedTime(date, zone);
  const startLocal = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 0, 0, 0, 0);
  const endLocal = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate() + 1, 0, 0, 0, 0);
  return { start: fromZonedTime(startLocal, zone), end: fromZonedTime(endLocal, zone) };
}

/** Start of `YYYY-MM-DD` in the configured timezone, as an absolute instant. */
export function startOfIsoDay(isoDay: string, timeZone?: string): Date {
  return fromZonedTime(`${isoDay}T00:00:00`, tz(timeZone));
}

/** First instant of the calendar month containing `date`. */
export function startOfMonth(date: Date, timeZone?: string): Date {
  const zone = tz(timeZone);
  const zoned = toZonedTime(date, zone);
  return fromZonedTime(new Date(zoned.getFullYear(), zoned.getMonth(), 1, 0, 0, 0, 0), zone);
}

/** Exclusive end of `YYYY-MM-DD` in the configured timezone. */
export function endOfIsoDay(isoDay: string, timeZone?: string): Date {
  const start = startOfIsoDay(isoDay, timeZone);
  return dayBoundaries(start, timeZone).end;
}

/**
 * SLA deadline. Deliberately a pure function of createdAt: nothing in the
 * workflow (revision, reassignment, AI) is allowed to recompute it later.
 */
export function computeDeadline(createdAt: Date, slaHours: number): Date {
  return addHours(createdAt, slaHours);
}

export function hoursUntil(target: Date, now: Date = new Date()): number {
  return (target.getTime() - now.getTime()) / 3_600_000;
}
