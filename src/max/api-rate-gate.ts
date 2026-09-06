/** Space request starts, not their completion. Slow requests do not block
 * unrelated dialogs. Per-target keys disappear after their last waiter.
 */
export class ApiRateGate {
  private readonly queues = new Map<string, Promise<void>>();
  async wait(key: string, spacingMs: number, beforeStart?: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const next = previous.then(async () => {
      await beforeStart?.();
      release();
      await new Promise<void>(resolve => setTimeout(resolve, spacingMs));
    });
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    await started;
  }
}
