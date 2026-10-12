/**
 * Server error counting for every Worker's top-level handlers.
 *
 * Fail-open is the whole contract: the wrapper never changes a response, never swallows or
 * replaces a thrown error, and never lets its own failure (a missing binding, an old Auth
 * deployment without the method, a D1 error) reach the request. Counts are coalesced per isolate
 * and flushed after a short delay through `waitUntil`, so an error storm costs one write per
 * isolate per flush, not one per failed request.
 */

export const SERVER_ERROR_WORKERS = ['auth', 'chat', 'market', 'voice', 'llm-proxy'] as const;
export type ServerErrorWorker = (typeof SERVER_ERROR_WORKERS)[number];

/** `http_5xx`: a 5xx response; `exception`: a thrown fetch handler; `scheduled`: a failed cron. */
export const SERVER_ERROR_KINDS = ['http_5xx', 'exception', 'scheduled'] as const;
export type ServerErrorKind = (typeof SERVER_ERROR_KINDS)[number];

/** One flush per isolate never claims more than this per kind. */
export const MAX_SERVER_ERROR_COUNT = 10_000;

export interface ServerErrorReport {
  worker: ServerErrorWorker;
  counts: Array<{ kind: ServerErrorKind; count: number }>;
}

export interface ServerErrorSink {
  recordServerErrors(report: ServerErrorReport): Promise<unknown>;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Method syntax keeps parameters bivariant, so concrete Worker handlers fit. */
export interface MonitoredHandler<Env> {
  fetch?(request: Request, env: Env, ctx: WaitUntilContext): Response | Promise<Response>;
  scheduled?(controller: unknown, env: Env, ctx: WaitUntilContext): void | Promise<void>;
}

export interface ServerErrorCountingOptions<Env> {
  worker: ServerErrorWorker;
  /** The sink for this request's env, or undefined when monitoring is not bound. */
  sink(env: Env): ServerErrorSink | undefined;
  /** Delay before a flush, so a burst becomes one write. */
  flushDelayMs?: number;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Validate an untrusted (service-binding) report; returns null for anything malformed. */
export function parseServerErrorReport(value: unknown): ServerErrorReport | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (!oneOf(SERVER_ERROR_WORKERS, input.worker) || !Array.isArray(input.counts)) return null;
  if (input.counts.length === 0 || input.counts.length > SERVER_ERROR_KINDS.length) return null;
  const counts: ServerErrorReport['counts'] = [];
  const seen = new Set<string>();
  for (const entry of input.counts as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const { kind, count } = entry as Record<string, unknown>;
    if (!oneOf(SERVER_ERROR_KINDS, kind) || seen.has(kind)) return null;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
    seen.add(kind);
    counts.push({ kind, count: Math.min(count, MAX_SERVER_ERROR_COUNT) });
  }
  return { worker: input.worker, counts };
}

function keepAlive(ctx: WaitUntilContext | undefined, promise: Promise<unknown>): void {
  try {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
  } catch {
    // Without waitUntil the flush may be cut short; that only loses a count.
  }
}

/**
 * The scheduled ctx with `waitUntil` observed, so a cron whose background work rejects is
 * counted too. Anything unexpected falls back to the original ctx.
 */
function observeBackground(ctx: unknown, onFailure: () => void): WaitUntilContext {
  try {
    const target = ctx as WaitUntilContext;
    if (!target || typeof target.waitUntil !== 'function') return target;
    return new Proxy(target, {
      get(object, property) {
        if (property === 'waitUntil') {
          return (promise: Promise<unknown>) =>
            object.waitUntil(
              Promise.resolve(promise).catch((error: unknown) => {
                onFailure();
                throw error;
              }),
            );
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(object)
          : value;
      },
    });
  } catch {
    return ctx as WaitUntilContext;
  }
}

/** Wrap a Worker's default export; the result has the same shape and behavior. */
export function withServerErrorCounting<Env, Handler extends MonitoredHandler<Env>>(
  handler: Handler,
  options: ServerErrorCountingOptions<Env>,
): Handler & MonitoredHandler<Env> {
  const pending = new Map<ServerErrorKind, number>();
  let scheduled = false;
  const delay = options.flushDelayMs ?? 1000;

  const flush = async (env: Env): Promise<void> => {
    scheduled = false;
    const counts = [...pending].map(([kind, count]) => ({
      kind,
      count: Math.min(count, MAX_SERVER_ERROR_COUNT),
    }));
    pending.clear();
    if (counts.length === 0) return;
    try {
      const sink = options.sink(env);
      if (sink) await sink.recordServerErrors({ worker: options.worker, counts });
    } catch {
      // Monitoring is best effort; the next flush starts from zero rather than retrying.
    }
  };

  const record = (kind: ServerErrorKind, env: Env, ctx: WaitUntilContext | undefined): void => {
    try {
      pending.set(kind, (pending.get(kind) ?? 0) + 1);
      if (scheduled) return;
      scheduled = true;
      const run = new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => flush(env));
      keepAlive(ctx, run);
    } catch {
      scheduled = false;
    }
  };

  const wrapped: MonitoredHandler<Env> = { ...handler };
  if (handler.fetch) {
    const inner = handler.fetch;
    wrapped.fetch = async (request, env, ctx) => {
      let response: Response;
      try {
        response = await inner.call(handler, request, env, ctx);
      } catch (error) {
        record('exception', env, ctx);
        throw error;
      }
      try {
        if (response.status >= 500) record('http_5xx', env, ctx);
      } catch {
        // A response-like object without a status is the handler's problem, not ours.
      }
      return response;
    };
  }
  if (handler.scheduled) {
    const inner = handler.scheduled;
    wrapped.scheduled = async (controller, env, ctx) => {
      const observed = observeBackground(ctx, () => record('scheduled', env, ctx));
      try {
        await inner.call(handler, controller, env, observed);
      } catch (error) {
        record('scheduled', env, ctx);
        throw error;
      }
    };
  }
  return wrapped as Handler & MonitoredHandler<Env>;
}
