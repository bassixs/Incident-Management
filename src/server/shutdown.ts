type ShutdownSteps = {
  closeIngress: () => Promise<unknown>;
  waitForHandlers: () => Promise<unknown>;
  waitForMessages: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
};

/** A timeout must never disconnect the database underneath active handlers. */
export async function completeShutdown(steps: ShutdownSteps, timeoutMs = 60_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('Graceful shutdown timed out')); }, timeoutMs);
  });
  const finish = async () => {
    await steps.closeIngress();
    await steps.waitForHandlers();
    await steps.waitForMessages();
    if (!expired) await steps.disconnect();
  };
  try { await Promise.race([finish(), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}
