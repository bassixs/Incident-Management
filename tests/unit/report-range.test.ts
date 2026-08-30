import { describe, expect, it } from 'vitest';

import { parseReportRange, rangeForPreset, reportFileName } from '../../src/reports/report-range';
import { ValidationError } from '../../src/utils/errors';

const NOW = new Date('2026-08-23T15:42:00.000Z');

describe('/report presets', () => {
  it('defaults to today when nothing follows the command', () => {
    const range = parseReportRange([], NOW);
    expect(range.from?.toISOString()).toBe('2026-08-22T21:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-08-23T21:00:00.000Z');
    expect(reportFileName(range)).toBe('incident-report-2026-08-23.xlsx');
    expect(range.title).toBe('за 23.08.2026');
  });

  it('handles the week and month buttons', () => {
    const week = rangeForPreset('7d', NOW);
    expect(week.from?.toISOString()).toBe('2026-08-16T21:00:00.000Z');
    expect(week.to?.toISOString()).toBe('2026-08-23T21:00:00.000Z');

    const thirty = rangeForPreset('30d', NOW);
    expect(thirty.from?.toISOString()).toBe('2026-07-24T21:00:00.000Z');

    // "Этот месяц" runs from the 1st of the current month through today.
    const month = rangeForPreset('month', NOW);
    expect(month.from?.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    expect(month.to?.toISOString()).toBe('2026-08-23T21:00:00.000Z');
  });

  it('handles an unbounded report', () => {
    const range = rangeForPreset('all', NOW);
    expect(range.from).toBeUndefined();
    expect(range.to).toBeUndefined();
    expect(reportFileName(range)).toBe('incident-report-all.xlsx');
  });
});

describe('/report manual periods', () => {
  it('accepts the operator-facing дд.мм.гггг range', () => {
    const range = parseReportRange('01.08.2026 - 10.08.2026', NOW);
    expect(range.from?.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    // End is exclusive: the first instant after 10 August, Moscow time.
    expect(range.to?.toISOString()).toBe('2026-08-10T21:00:00.000Z');
    expect(range.title).toBe('за 01.08.2026 — 10.08.2026');
    expect(reportFileName(range)).toBe('incident-report-2026-08-01_2026-08-10.xlsx');
  });

  it('is tolerant about how the range is written', () => {
    const expected = parseReportRange('01.08.2026 - 10.08.2026', NOW).from?.toISOString();
    for (const variant of [
      '01.08.2026-10.08.2026',
      '01.08.2026 10.08.2026',
      '01.08.2026 — 10.08.2026',
      '1.8.2026 - 10.8.2026',
    ]) {
      expect(parseReportRange(variant, NOW).from?.toISOString()).toBe(expected);
    }
  });

  it('accepts a single day', () => {
    const range = parseReportRange('05.08.2026', NOW);
    expect(range.from?.toISOString()).toBe('2026-08-04T21:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-08-05T21:00:00.000Z');
    expect(range.title).toBe('за 05.08.2026');
  });

  it('still accepts the ISO form used by scripts', () => {
    const range = parseReportRange(['2026-08-01', '2026-08-31'], NOW);
    expect(range.from?.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-08-31T21:00:00.000Z');
  });

  it('accepts relative and Russian shorthands', () => {
    expect(parseReportRange('7d', NOW).from?.toISOString()).toBe(
      rangeForPreset('7d', NOW).from?.toISOString(),
    );
    expect(parseReportRange('сегодня', NOW).title).toBe('за 23.08.2026');
    expect(parseReportRange('неделя', NOW).title).toBe('за последние 7 дн.');
    expect(parseReportRange('месяц', NOW).title).toBe('за текущий месяц');
  });

  it('rejects nonsense, reversed ranges and impossible dates', () => {
    expect(() => parseReportRange('вчера или позавчера', NOW)).toThrow(ValidationError);
    expect(() => parseReportRange('31.08.2026 - 01.08.2026', NOW)).toThrow(ValidationError);
    expect(() => parseReportRange('2026-08-31 2026-08-01', NOW)).toThrow(ValidationError);
    expect(() => parseReportRange('45.13.2026', NOW)).toThrow(ValidationError);
  });

  it('explains the expected format when it fails', () => {
    try {
      parseReportRange('как-нибудь', NOW);
    } catch (error) {
      expect((error as ValidationError).message).toContain('01.08.2026 - 10.08.2026');
    }
  });
});
