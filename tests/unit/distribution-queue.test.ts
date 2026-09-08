import { expect, it } from 'vitest';
import { distributionAlertsAllowed } from '../../src/distribution/queue-state';
import { parseCallbackPayload } from '../../src/max/callback-payload';

it('allows alerts only on weekdays from 08:00 inclusive to 17:00 exclusive Moscow time', () => {
  const config = { WORKDAY_START: '08:00', WORKDAY_END: '17:00' };
  for (const day of ['2026-09-07', '2026-09-11']) {
    expect(distributionAlertsAllowed(new Date(`${day}T04:59:59Z`), config)).toBe(false);
    expect(distributionAlertsAllowed(new Date(`${day}T05:00:00Z`), config)).toBe(true);
    expect(distributionAlertsAllowed(new Date(`${day}T13:59:59Z`), config)).toBe(true);
    expect(distributionAlertsAllowed(new Date(`${day}T14:00:00Z`), config)).toBe(false);
  }
  for (const day of ['2026-09-12', '2026-09-13'])
    expect(distributionAlertsAllowed(new Date(`${day}T10:00:00Z`), config)).toBe(false);
});

it('parses only bounded queue pages and valid incident identifiers', () => {
  expect(parseCallbackPayload('queue:next')).toEqual({ kind: 'queue', action: 'next' });
  expect(parseCallbackPayload('queue:list:12')).toEqual({ kind: 'queue', action: 'list', argument: '12' });
  for (const value of ['queue:delete', 'queue:list:-1', 'queue:list:9999999999999', 'queue:next:extra', 'queue:open:bad', 'queue:release:bad']) {
    expect(parseCallbackPayload(value)).toBeNull();
  }
});
