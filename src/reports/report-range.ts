import { subDays } from 'date-fns';

import {
  dayBoundaries,
  endOfIsoDay,
  formatIsoDay,
  startOfIsoDay,
  startOfMonth,
} from '../utils/datetime';
import { ValidationError } from '../utils/errors';

export type ReportRange = {
  from?: Date;
  to?: Date;
  /** Used in the file name: `incident-report-<slug>.xlsx`. */
  slug: string;
  title: string;
};

/** Presets offered as buttons under `/report`. */
export const REPORT_PRESETS = ['today', '7d', '30d', 'month', 'all'] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const PRESET_LABELS: Record<ReportPreset, string> = {
  today: 'Сегодня',
  '7d': 'Неделя',
  '30d': '30 дней',
  month: 'Этот месяц',
  all: 'Всё время',
};

const ISO_DAY = /\d{4}-\d{2}-\d{2}/g;
const RU_DAY = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;

export const PERIOD_TEMPLATE = '01.08.2026 - 10.08.2026';

export const REPORT_USAGE = [
  'Укажите период одним сообщением, например:',
  '',
  PERIOD_TEMPLATE,
  '',
  'Можно и одну дату — тогда отчёт будет за этот день.',
].join('\n');

function ruToIso(day: string, month: string, year: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Collect calendar days from free text, in either `дд.мм.гггг` or ISO form. */
function extractDays(raw: string): string[] {
  const ru = [...raw.matchAll(RU_DAY)].map((match) => ruToIso(match[1]!, match[2]!, match[3]!));
  if (ru.length > 0) return ru;
  return raw.match(ISO_DAY) ?? [];
}

function rangeFromDays(days: string[]): ReportRange {
  const [first, second = first] = days;
  const fromDay = first!;
  const toDay = second!;

  let from: Date;
  let to: Date;
  try {
    from = startOfIsoDay(fromDay);
    to = endOfIsoDay(toDay);
  } catch {
    throw new ValidationError(`Не удалось разобрать даты.\n\n${REPORT_USAGE}`);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError(`Такой даты не существует.\n\n${REPORT_USAGE}`);
  }
  if (to.getTime() <= from.getTime()) {
    throw new ValidationError(`Конечная дата раньше начальной.\n\n${REPORT_USAGE}`);
  }

  const title =
    fromDay === toDay
      ? `за ${formatRu(fromDay)}`
      : `за ${formatRu(fromDay)} — ${formatRu(toDay)}`;
  return { from, to, slug: `${fromDay}_${toDay}`, title };
}

function formatRu(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day}.${month}.${year}`;
}

export function rangeForPreset(preset: ReportPreset, now = new Date()): ReportRange {
  switch (preset) {
    case 'all':
      return { slug: 'all', title: 'за всё время' };

    case 'today': {
      const { start, end } = dayBoundaries(now);
      const day = formatIsoDay(now);
      return { from: start, to: end, slug: day, title: `за ${formatRu(day)}` };
    }

    case 'month': {
      const start = startOfMonth(now);
      const { end } = dayBoundaries(now);
      return {
        from: start,
        to: end,
        slug: `${formatIsoDay(start)}_${formatIsoDay(now)}`,
        title: `за текущий месяц`,
      };
    }

    default: {
      const days = preset === '7d' ? 7 : 30;
      const { end } = dayBoundaries(now);
      const { start } = dayBoundaries(subDays(now, days - 1));
      return {
        from: start,
        to: end,
        slug: `${formatIsoDay(start)}_${formatIsoDay(now)}`,
        title: `за последние ${days} дн.`,
      };
    }
  }
}

/**
 * Parse whatever followed `/report`, or the period typed after the
 * "Указать период" button.
 *
 * Accepts the presets, the Russian `01.08.2026 - 10.08.2026` form the
 * operators asked for, and the ISO form kept for scripts.
 */
export function parseReportRange(args: string[] | string, now = new Date()): ReportRange {
  const raw = (Array.isArray(args) ? args.join(' ') : args).trim();
  if (raw === '') return rangeForPreset('today', now);

  const normalised = raw.toLowerCase();
  if ((REPORT_PRESETS as readonly string[]).includes(normalised)) {
    return rangeForPreset(normalised as ReportPreset, now);
  }
  if (normalised === 'week' || normalised === 'неделя') return rangeForPreset('7d', now);
  if (normalised === 'месяц') return rangeForPreset('month', now);
  if (normalised === 'сегодня') return rangeForPreset('today', now);
  if (normalised === 'всё' || normalised === 'все') return rangeForPreset('all', now);

  const relative = /^(\d{1,3})\s*(?:d|д|дн|дней)$/.exec(normalised);
  if (relative) {
    const days = Number(relative[1]);
    if (days < 1) throw new ValidationError(`Некорректный период.\n\n${REPORT_USAGE}`);
    const { end } = dayBoundaries(now);
    const { start } = dayBoundaries(subDays(now, days - 1));
    return {
      from: start,
      to: end,
      slug: `${formatIsoDay(start)}_${formatIsoDay(now)}`,
      title: `за последние ${days} дн.`,
    };
  }

  const days = extractDays(raw);
  if (days.length >= 1) return rangeFromDays(days.slice(0, 2));

  throw new ValidationError(`Не удалось разобрать период «${raw}».\n\n${REPORT_USAGE}`);
}

export function reportFileName(range: ReportRange): string {
  return `incident-report-${range.slug}.xlsx`;
}
