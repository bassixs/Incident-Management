import { afterEach, expect, it, vi } from 'vitest';
import { ApiRateGate } from '../../src/max/api-rate-gate';
afterEach(() => vi.useRealTimers());
it('spaces starts in each chat and globally while letting another chat proceed', async () => {
  vi.useFakeTimers();
  const gate = new ApiRateGate();
  const events: Array<{ key: string; at: number }> = [];
  const request = async (key: string) => { await gate.wait(key, 550, () => gate.wait('global', 45)); events.push({ key, at: Date.now() }); };
  const start = Date.now();
  const pending = Promise.all([request('a'), request('a'), request('b')]);
  await vi.advanceTimersByTimeAsync(0);
  expect(events.map(e => e.key)).toEqual(['a']);
  await vi.advanceTimersByTimeAsync(45);
  expect(events.map(e => e.key)).toEqual(['a', 'b']);
  await vi.advanceTimersByTimeAsync(505);
  await pending;
  expect(events).toEqual([{ key: 'a', at: start }, { key: 'b', at: start + 45 }, { key: 'a', at: start + 550 }]);
  await vi.runAllTimersAsync();
});
