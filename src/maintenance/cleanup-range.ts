import { parseReportRange, type ReportRange } from '../reports/report-range';
import { formatIsoDay } from '../utils/datetime';
import { ValidationError } from '../utils/errors';

export const CLEANUP_PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;

/** Destructive commands accept only a complete preset or one/two valid dates. */
export function parseCleanupRange(raw: string, now = new Date()): ReportRange {
  const value = raw.trim();
  if ((CLEANUP_PERIODS as readonly string[]).includes(value)) return parseReportRange(value, now);
  const match = /^(\d{2}\.\d{2}\.\d{4})(?:\s+-\s+(\d{2}\.\d{2}\.\d{4}))?$/.exec(value);
  if (!match) throw new ValidationError('Укажите период: today, 7d, 30d, 90d, all или даты, например 01.09.2026 - 07.09.2026.');
  for (const day of [match[1]!, match[2]].filter((item): item is string => Boolean(item))) {
    const [d, m, y] = day.split('.');
    const iso = `${y}-${m}-${d}`;
    const date = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new ValidationError('Такой даты не существует. Проверьте период.');
  }
  const range = parseReportRange(value, now);
  if (range.from && formatIsoDay(range.from) > formatIsoDay(now)) throw new ValidationError('Начальная дата находится в будущем.');
  return range;
}
