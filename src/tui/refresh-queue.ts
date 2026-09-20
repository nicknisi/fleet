// Timers, hooks and control notifications share one refresh. Keep one pending
// request (slow subsumes fast), including events arriving while a read is in
// flight. Errors cannot wedge the queue; the next request can still run.
export function createRefreshQueue(refresh: (slow: boolean) => Promise<void>) {
  let pending: boolean | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function drain(): Promise<void> {
    while (!stopped && pending !== null) {
      const slow = pending;
      pending = null;
      try {
        await refresh(slow);
      } catch {
        /* next request can retry */
      }
    }
  }
  function request(slow = false): Promise<void> {
    if (stopped) return Promise.resolve();
    pending = slow || pending === true;
    if (!running)
      running = drain().finally(() => {
        running = null;
        if (pending !== null && !stopped) void request(pending);
      });
    return running;
  }
  return {
    request,
    stop(): void {
      stopped = true;
      pending = null;
    },
  };
}
