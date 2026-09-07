import { expect, it, vi } from 'vitest';
import { withRuntimePaused } from '../../src/maintenance/runtime-maintenance';

it('waits for an in-flight handler and its sends before deleting; resumes on failure', async () => {
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const dispatcher = { pauseProcessing: () => { events.push('pause'); }, resumeProcessing: () => { events.push('resume'); }, waitForIdle: () => active };
  const worker = (name: string) => ({ stop: () => { events.push(`${name}-stop`); }, start: () => { events.push(`${name}-start`); }, waitForIdle: async () => { events.push(`${name}-idle`); } });
  const work = vi.fn(async () => { events.push('delete'); throw new Error('rollback'); });
  const run = withRuntimePaused(dispatcher, worker('messages'), [worker('sla')], work, () => false);
  const outcome = expect(run).rejects.toThrow('rollback');
  await Promise.resolve(); expect(work).not.toHaveBeenCalled();
  release(); await outcome;
  expect(events.indexOf('messages-idle')).toBeLessThan(events.indexOf('delete'));
  expect(events.slice(-3)).toEqual(['messages-start', 'sla-start', 'resume']);
});

it('never starts deletion or restarts workers during shutdown', async () => {
  const dispatcher = { pauseProcessing: vi.fn(), resumeProcessing: vi.fn(), waitForIdle: async () => undefined };
  const worker = { stop: vi.fn(), start: vi.fn(), waitForIdle: async () => undefined };
  const deletion = vi.fn();
  await withRuntimePaused(dispatcher, worker, [], deletion, () => true);
  expect(deletion).not.toHaveBeenCalled(); expect(worker.start).not.toHaveBeenCalled(); expect(dispatcher.resumeProcessing).not.toHaveBeenCalled();
});
