import { expect, it } from 'vitest';
import { distributionAlertsAllowed } from '../../src/distribution/queue-state';
import { parseCallbackPayload } from '../../src/max/callback-payload';

it('allows alerts every day from 08:00 inclusive to 22:00 exclusive Moscow time', () => {
  const config = { DISTRIBUTION_WORK_START: '08:00', DISTRIBUTION_WORK_END: '22:00' };
  for (const day of ['2026-09-06', '2026-09-07']) {
    expect(distributionAlertsAllowed(new Date(`${day}T04:59:59Z`), config)).toBe(false);
    expect(distributionAlertsAllowed(new Date(`${day}T05:00:00Z`), config)).toBe(true);
    expect(distributionAlertsAllowed(new Date(`${day}T18:59:59Z`), config)).toBe(true);
    expect(distributionAlertsAllowed(new Date(`${day}T19:00:00Z`), config)).toBe(false);
  }
});

it('parses only bounded queue pages and valid incident identifiers', () => {
  expect(parseCallbackPayload('queue:next')).toEqual({ kind: 'queue', action: 'next' });
  expect(parseCallbackPayload('queue:list:12')).toEqual({ kind: 'queue', action: 'list', argument: '12' });
  for (const value of ['queue:delete', 'queue:list:-1', 'queue:list:9999999999999', 'queue:next:extra', 'queue:open:bad', 'queue:release:bad']) {
    expect(parseCallbackPayload(value)).toBeNull();
  }
});
