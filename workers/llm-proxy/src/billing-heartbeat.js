/** Keep recovery's inactivity lease alive without extending the wallet reservation TTL. */
export function billingHeartbeat(service, key, capability, requestSignal) {
  const controller = new AbortController();
  let failed = false;
  let stopped = false;
  let rpcTimer;
  const abort = () => controller.abort();
  requestSignal.addEventListener('abort', abort, { once: true });
  if (requestSignal.aborted) abort();
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
      requestSignal.removeEventListener('abort', abort);
    },
  };
}
