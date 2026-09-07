type Worker = { stop(): void; start(): void; waitForIdle(): Promise<void> };
type Dispatcher = { pauseProcessing(): void; resumeProcessing(): void; waitForIdle(): Promise<void> };

/** Invoked by the separate cleanup worker, never awaited by an inbox handler. */
export async function withRuntimePaused(
  dispatcher: Dispatcher, messages: Worker, workers: Worker[],
  work: () => Promise<void>, shuttingDown: () => boolean,
): Promise<void> {
  dispatcher.pauseProcessing();
  for (const worker of workers) worker.stop();
  messages.stop();
  try {
    await Promise.all([dispatcher.waitForIdle(), ...workers.map(worker => worker.waitForIdle())]);
    await messages.waitForIdle();
    if (!shuttingDown()) await work();
  } finally {
    if (!shuttingDown()) {
      messages.start();
      for (const worker of workers) worker.start();
      dispatcher.resumeProcessing();
    }
  }
}
