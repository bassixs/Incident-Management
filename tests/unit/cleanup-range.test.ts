import { expect, it } from 'vitest';
import { parseCleanupRange } from '../../src/maintenance/cleanup-range';
import { parseCallbackPayload } from '../../src/max/callback-payload';
const now = new Date('2026-09-07T14:00:00Z');

it('uses Moscow calendar boundaries for all cleanup presets and custom dates', () => {
  expect(parseCleanupRange('today', now).from?.toISOString()).toBe('2026-09-06T21:00:00.000Z');
  expect(parseCleanupRange('7d', now).from?.toISOString()).toBe('2026-08-31T21:00:00.000Z');
  expect(parseCleanupRange('30d', now).from?.toISOString()).toBe('2026-08-08T21:00:00.000Z');
  expect(parseCleanupRange('90d', now).from?.toISOString()).toBe('2026-06-09T21:00:00.000Z');
  expect(parseCleanupRange('all', now).from).toBeUndefined();
  expect(parseCleanupRange('01.09.2026 - 07.09.2026', now)).toMatchObject({ from: new Date('2026-08-31T21:00:00Z'), to: new Date('2026-09-07T21:00:00Z') });
});

it.each(['', '0d', 'all extra', 'remove 07.09.2026', '31.02.2026', '29.02.2025', '07.09.2026 - 01.09.2026', '01.10.2026', '01.09.2026 - 02.09.2026 - 03.09.2026'])('rejects ambiguous or invalid destructive period: %s', raw => {
  expect(() => parseCleanupRange(raw, now)).toThrow();
});

it('cleanup callbacks can only select a period, never authorize deletion', () => {
  expect(parseCallbackPayload('cleanup:90d')).toEqual({ kind: 'cleanup', action: '90d' });
  for (const raw of ['cleanup:confirm', 'cleanup:all:extra', 'cleanup:users', 'cleanup:']) expect(parseCallbackPayload(raw)).toBeNull();
});
