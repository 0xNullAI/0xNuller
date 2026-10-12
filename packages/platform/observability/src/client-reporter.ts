import {
  CLIENT_ERROR_LIMITS,
  clientErrorSignatureSource,
  sanitizeErrorMessage,
  sanitizeRoute,
  sanitizeStack,
  type ClientErrorKind,
  type ClientErrorPlatform,
  type ClientErrorReport,
} from './client-errors';

/**
 * Browser side of client error reporting, shared by the web shell and the Android WebView.
 *
 * Reports are sanitized before they leave the device, deduplicated, and capped per minute and
 * per launch, so a render loop cannot turn into a request loop. Sending never carries cookies or
 * the Bearer token (`credentials: 'omit'`), and a failed send is dropped, never retried or logged
 * through a path that could report itself again.
 */

export interface ClientErrorReporterOptions {
  platform: ClientErrorPlatform;
  version: string;
  buildId: string;
  /** Absolute or same-origin URL of the Auth intake endpoint. */
  endpoint: string;
  send?: (endpoint: string, body: string) => Promise<unknown>;
  now?: () => number;
  pathname?: () => string;
  sessionId?: string;
  maxPerMinute?: number;
  maxPerSession?: number;
  /** An identical error is reported again only after this long. */
  dedupeWindowMs?: number;
}

export interface ClientErrorReporter {
  /** Returns true when the report was handed to the sender. */
  report(error: unknown, context?: { kind?: ClientErrorKind; moduleId?: string | null }): boolean;
}

function defaultSend(endpoint: string, body: string): Promise<unknown> {
  return fetch(endpoint, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    keepalive: true,
  });
}

function randomSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
  }
}

function describe(error: unknown): { message: string; stack: unknown } {
  if (error instanceof Error)
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error, stack: null };
  // Never serialize an arbitrary rejection value: it may be a request body or a chat message.
  return {
    message: `Non-error rejection (${error === null ? 'null' : typeof error})`,
    stack: null,
  };
}

export function createClientErrorReporter(
  options: ClientErrorReporterOptions,
): ClientErrorReporter {
  const send = options.send ?? defaultSend;
  const now = options.now ?? Date.now;
  const pathname = options.pathname ?? (() => globalThis.location?.pathname ?? '/');
  const sessionId = options.sessionId ?? randomSessionId();
  const maxPerMinute = options.maxPerMinute ?? 5;
  const maxPerSession = options.maxPerSession ?? 50;
  const dedupeWindowMs = options.dedupeWindowMs ?? 10 * 60 * 1000;
  const lastSent = new Map<string, number>();
  const recent: number[] = [];
  let total = 0;

  return {
    report(error, context = {}) {
      try {
        if (total >= maxPerSession) return false;
        const at = now();
        while (recent.length && recent[0]! <= at - 60_000) recent.shift();
        if (recent.length >= maxPerMinute) return false;

        const described = describe(error);
        const message = sanitizeErrorMessage(described.message);
        const stack = sanitizeStack(described.stack);
        const key = `${context.moduleId ?? ''}\n${clientErrorSignatureSource(message, stack)}`;
        const previous = lastSent.get(key);
        if (previous !== undefined && at - previous < dedupeWindowMs) return false;

        const report: ClientErrorReport = {
          kind: context.kind ?? 'error',
          message,
          stack,
          moduleId: context.moduleId ?? null,
          platform: options.platform,
          version: options.version,
          buildId: options.buildId,
          route: sanitizeRoute(pathname()),
          occurredAt: at,
          sessionId,
        };
        let body = JSON.stringify(report);
        if (body.length > CLIENT_ERROR_LIMITS.bodyBytes / 2)
          body = JSON.stringify({ ...report, stack: null });

        lastSent.set(key, at);
        if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value!);
        recent.push(at);
        total++;
        void Promise.resolve()
          .then(() => send(options.endpoint, body))
          .catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
  };
}

let active: ClientErrorReporter | null = null;

interface ErrorEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Listen for uncaught errors and unhandled rejections on `target` (normally `window`) and make
 * the reporter available to error boundaries. Returns an uninstall function.
 */
export function installClientErrorReporting(
  target: ErrorEventTarget,
  options: ClientErrorReporterOptions,
): () => void {
  const reporter = createClientErrorReporter(options);
  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent;
    reporter.report(errorEvent.error ?? errorEvent.message ?? 'Unknown error', { kind: 'error' });
  };
  const onRejection = (event: Event) => {
    reporter.report((event as PromiseRejectionEvent).reason, { kind: 'unhandledrejection' });
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  active = reporter;
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    if (active === reporter) active = null;
  };
}

/** Report an error caught by a module error boundary; a no-op before installation. */
export function reportModuleError(error: unknown, moduleId: string): void {
  active?.report(error, { kind: 'boundary', moduleId });
}
