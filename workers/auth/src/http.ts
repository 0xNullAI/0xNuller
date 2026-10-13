/** Build a JSON response with the account API's stable content type. */
export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Build the account API's standard error envelope. */
export function err(message: string, status: number, headers: HeadersInit = {}): Response {
  return json({ error: message }, status, headers);
}

/**
 * Echo the concrete origin rather than `*` — credentialed requests and a wildcard
 * origin cannot coexist.
 */
export function corsHeaders(request: Request, allowedOrigins: string): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = allowedOrigins
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    // Authorization must be on the allowlist: leave it out and the browser blocks
    // the request outright at the preflight stage, which shows up as "the request
    // never even went out" rather than a catchable 401.
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Account-Id,X-Photo-Caption,X-Photo-Visibility,X-Photo-Purpose',
    Vary: 'Origin',
  };
}

/** Read a streaming request body without accepting more than the configured limit. */
export async function readBodyBounded(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

/** A mistake in the client's request itself; the router answers it with `status`, never a 500. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Ordinary form-sized JSON. Larger bodies name their own cap. */
const DEFAULT_JSON_BYTES = 256 * 1024;

/**
 * Parse a bounded JSON object body. Oversized bodies are always refused (413). Malformed or
 * non-object bodies are refused (400) unless `lenient`, where they read as an empty object for
 * routes whose fields are all optional.
 */
export async function readJson<T = Record<string, unknown>>(
  request: Request,
  { maxBytes = DEFAULT_JSON_BYTES, lenient = false }: { maxBytes?: number; lenient?: boolean } = {},
): Promise<T> {
  const bytes = await readBodyBounded(request, maxBytes);
  if (!bytes) throw new RequestError('请求体过大', 413);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value !== null && typeof value === 'object') return value as T;
  } catch {
    /* handled below */
  }
  if (lenient) return {} as T;
  throw new RequestError('请求格式无效', 400);
}
