import { afterEach, expect, it, vi } from 'vitest';
import { completeShutdown } from '../../src/server/shutdown';
import { PollingRunner } from '../../src/server/polling.runner';

afterEach(() => vi.useRealTimers());

it('waits for handlers and their outgoing work before disconnecting the database', async () => {
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const work = completeShutdown({
    closeIngress: async () => { order.push('closed'); },
    waitForHandlers: async () => { order.push('waiting'); await active; order.push('finished'); },
    waitForMessages: async () => { order.push('messages'); },
    disconnect: async () => { order.push('disconnect'); },
  });
  await vi.waitFor(() => expect(order).toContain('waiting'));
  expect(order).not.toContain('disconnect');
  release();
  await work;
  expect(order).toEqual(['closed', 'waiting', 'finished', 'messages', 'disconnect']);
});

it('times out without disconnecting underneath a handler, even if it finishes later', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const disconnect = vi.fn();
  const result = completeShutdown({ closeIngress: async () => undefined, waitForHandlers: () => active,
    waitForMessages: async () => undefined, disconnect }, 60_000);
  const failure = expect(result).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(60_000);
  await failure;
  release();
  await vi.runAllTimersAsync();
  expect(disconnect).not.toHaveBeenCalled();
});

it('does not process a late long-poll response or advance its marker after stop', async () => {
  let release!: (value: unknown) => void;
  const response = new Promise(resolve => { release = resolve; });
  const getUpdates = vi.fn().mockReturnValue(response);
  const handle = vi.fn();
  const upsert = vi.fn();
  const runner = new PollingRunner({ systemSetting: { findUnique: async () => null, upsert } } as never,
    { api: { getUpdates } } as never, { handle } as never);
  await runner.start();
  await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled());
  runner.stop();
  release({ updates: [{ update_type: 'message_created' }], marker: 123 });
  await runner.waitForIdle();
  expect(handle).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
});
