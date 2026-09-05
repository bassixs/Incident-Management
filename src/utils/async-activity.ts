/** Tracks work already started so shutdown can wait without starting new work. */
export class AsyncActivity {
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
