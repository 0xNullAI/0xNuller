/**
 * Client error reports: the one shape the shell sends and the Auth Worker stores.
 *
 * Both sides run the same sanitizer. The client strips before anything leaves the device; the
 * server strips again because a report is untrusted input and an old or modified client must
 * not be able to store a secret just by skipping the first pass.
 *
 * Never part of a report: chat or prompt content, request bodies, query strings, cookies,
 * tokens, keys, emails, usernames or account ids. The session id is a random value created per
 * app launch and never persisted, so it cannot be joined to an account.
 */

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'boundary'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export const CLIENT_ERROR_PLATFORMS = ['web', 'android'] as const;
export type ClientErrorPlatform = (typeof CLIENT_ERROR_PLATFORMS)[number];

export const CLIENT_ERROR_LIMITS = {
  message: 300,
  stack: 2000,
  stackFrames: 12,
  topFrame: 200,
  route: 80,
  /** Upper bound for one request body; the server rejects anything larger unread. */
  bodyBytes: 8 * 1024,
} as const;

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  moduleId: string | null;
  platform: ClientErrorPlatform;
  version: string;
  buildId: string;
  route: string;
  occurredAt: number;
  sessionId: string;
}

const URL_PATTERN = /\b(?:https?|wss?|tauri|asset|ipc|file|blob:https?):\/\/[^\s"'`<>()]+/gi;

/** Keep scheme, host and path of every URL; drop query strings and fragments. */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_PATTERN, (url) => url.replace(/[?#].*$/, ''));
}

const SECRET_KEY =
  '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|pwd|ticket|session(?:[_-]?id)?|authorization|auth|cookie|signature|sig|key)';

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g, '[token]'],
  // key=value, key: value and "key":"value" forms.
  [
    new RegExp(`(["']?\\b${SECRET_KEY}\\b["']?\\s*[=:]\\s*["']?)[^\\s"'&,;)}]+`, 'gi'),
    '$1[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, '[key]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/\b[0-9a-f]{16,}\b/gi, '[hex]'],
  // Long opaque runs mixing letters and digits: keys and tokens without a known prefix.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[redacted]'],
  // Phone numbers and numeric ids; `:line:col` positions in stacks are kept.
  [/(?<![:\d])\d{7,}/g, '[number]'],
  // Quoted text long enough to be someone's message (JSON.parse echoes, server errors).
  [/(["'“「『])[^"'”」』\n]{24,}(["'”」』])/g, '$1[…]$2'],
  // Unquoted long runs of Chinese text are far more likely user content than our own errors.
  [/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]{20,}/g, '[text]'],
];

/** Remove secrets, identifiers and likely user content from free text. */
export function redactSensitiveText(text: string): string {
  let result = stripUrlQueries(text);
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function sanitizeErrorMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const clean = redactSensitiveText(text.slice(0, 4 * CLIENT_ERROR_LIMITS.message))
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(clean || '(no message)', CLIENT_ERROR_LIMITS.message);
}

export function sanitizeStack(stack: unknown): string | null {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const lines = stack
    .slice(0, 4 * CLIENT_ERROR_LIMITS.stack)
    .split('\n')
    .map((line) => redactSensitiveText(line).trim())
    .filter(Boolean)
    .slice(0, CLIENT_ERROR_LIMITS.stackFrames + 1);
  return lines.length ? truncate(lines.join('\n'), CLIENT_ERROR_LIMITS.stack) : null;
}

// Pages whose second segment is a fixed sub-page rather than a person, room or record.
const STATIC_SUBROUTES = new Set(['settings']);
const ROUTE_SEGMENT = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * A route without query, fragment or identifiers. Only the module segment is kept, plus the
 * sub-page of allowlisted static areas; `/u/alice` becomes `/u/:param`.
 */
export function sanitizeRoute(pathname: unknown): string {
  if (typeof pathname !== 'string') return '/';
  const path = pathname.replace(/[?#].*$/, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  const parts = segments.slice(0, 3).map((segment, index) => {
    if (index === 0) return ROUTE_SEGMENT.test(segment) ? segment : ':param';
    if (index === 1 && STATIC_SUBROUTES.has(segments[0]!) && ROUTE_SEGMENT.test(segment))
      return segment;
    return ':param';
  });
  return truncate(`/${parts.join('/')}`, CLIENT_ERROR_LIMITS.route);
}

/** First stack frame that names code, without bundle hashes or line numbers. */
export function topStackFrame(stack: string | null): string | null {
  if (!stack) return null;
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    // V8: "at fn (url:1:2)" / "at url:1:2"; Firefox/Safari: "fn@url:1:2". A V8 message line
    // matches neither, so the first real frame wins on every engine.
    const match =
      line.match(/^at\s+(?:(.+?)\s+\()?(.+?)\)?$/) ?? line.match(/^(.*?)@(.+?:\d+(?::\d+)?)$/);
    if (!match) continue;
    const fn = (match[1] ?? '').trim() || '<anonymous>';
    const location = (match[2] ?? '')
      .replace(/^[a-z-]+:\/\/[^/]+/i, '')
      .replace(/:\d+(?::\d+)?$/, '')
      .replace(/-[A-Za-z0-9_]{6,12}(\.m?js)$/, '$1');
    if (!location) continue;
    return truncate(`${fn} ${location}`, CLIENT_ERROR_LIMITS.topFrame);
  }
  return null;
}

/**
 * What makes two reports "the same error": the message with numbers folded, plus the top frame.
 * The server hashes this; the client uses it as its dedupe key.
 */
export function clientErrorSignatureSource(message: string, stack: string | null): string {
  const normalized = message.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${normalized}\n${topStackFrame(stack) ?? ''}`;
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const BUILD_ID = /^[0-9A-Za-z._-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * Validate an untrusted report and return a re-sanitized copy, or null. Unknown fields are
 * dropped, so a client cannot attach anything the schema does not name.
 */
export function parseClientErrorReport(value: unknown): ClientErrorReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!oneOf(CLIENT_ERROR_KINDS, input.kind) || !oneOf(CLIENT_ERROR_PLATFORMS, input.platform))
    return null;
  if (typeof input.message !== 'string' || !input.message.trim()) return null;
  if (input.stack != null && typeof input.stack !== 'string') return null;
  if (
    input.moduleId != null &&
    (typeof input.moduleId !== 'string' || !MODULE_ID.test(input.moduleId))
  )
    return null;
  if (typeof input.version !== 'string' || !VERSION.test(input.version)) return null;
  if (typeof input.buildId !== 'string' || !BUILD_ID.test(input.buildId)) return null;
  if (typeof input.route !== 'string') return null;
  if (typeof input.occurredAt !== 'number' || !Number.isFinite(input.occurredAt)) return null;
  if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return null;
  return {
    kind: input.kind,
    message: sanitizeErrorMessage(input.message),
    stack: sanitizeStack(input.stack),
    moduleId: (input.moduleId as string | null | undefined) ?? null,
    platform: input.platform,
    version: input.version,
    buildId: input.buildId,
    route: sanitizeRoute(input.route),
    occurredAt: Math.trunc(input.occurredAt),
    sessionId: input.sessionId,
  };
}
