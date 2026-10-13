/**
 * Keep recovery's inactivity lease alive without extending the wallet reservation TTL.
 * Only a lost lease aborts the signal: a browser that disconnects mid-call does not stop
 * paid inference upstream, so the work it started must still run to its usage and settle.
 */
export function billingHeartbeat(service, key, capability) {
  const controller = new AbortController();
  let failed = false;
  let stopped = false;
  let rpcTimer;
  const timer = setInterval(async () => {
    try {
      const result = await Promise.race([
        service.heartbeatManagedText(key, capability),
        new Promise((_, reject) => {
          rpcTimer = setTimeout(() => reject(new Error('heartbeat_timeout')), 3000);
        }),
      ]);
      if (result?.status !== 'running') throw new Error('heartbeat_rejected');
    } catch {
      if (!stopped) {
        failed = true;
        controller.abort();
      }
    } finally {
      clearTimeout(rpcTimer);
    }
  }, 60_000);
  return {
    signal: controller.signal,
    get failed() {
      return failed;
    },
    async run(promise) {
      let listener;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            listener = () => reject(new Error('request_cancelled'));
            controller.signal.addEventListener('abort', listener, { once: true });
            if (controller.signal.aborted) listener();
          }),
        ]);
      } finally {
        controller.signal.removeEventListener('abort', listener);
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
