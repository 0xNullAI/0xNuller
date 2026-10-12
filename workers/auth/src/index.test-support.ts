// Shared setup for the auth router contract tests (index.*.test.ts). This is not a
// test file; each suite calls useAuthWorkerTestEnv(createTestDb) to get a fresh database, fake
// R2 bucket and bindings per test.
import { afterEach, beforeEach } from 'vitest';
import worker, { type Env } from './index';
import { verifyDmTicket } from './dm-ticket';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';

export const ORIGIN = 'https://0xnullai.com';
// The suites pass createTestDb in, so this module does not import node:sqlite and
// stays valid under the production tsconfig, which only excludes *.test.ts files
// and test-helpers.ts.
type TestDb = { DB: unknown; close(): void };
let db: TestDb;
export let env: Env;
export let photos: FakePhotos;
export let sentEmails: unknown[];

export class FakePhotos {
  readonly objects = new Map<string, { bytes: ArrayBuffer; contentType: string; uploaded: Date }>();
  failPuts = 0;
  failDeletes = 0;

  async put(key: string, value: ArrayBuffer, options?: R2PutOptions): Promise<R2Object> {
    if (this.failPuts-- > 0) throw new Error('fake R2 put failure');
    this.objects.set(key, {
      bytes: value.slice(0),
      contentType:
        options?.httpMetadata instanceof Headers
          ? (options.httpMetadata.get('content-type') ?? 'application/octet-stream')
          : (options?.httpMetadata?.contentType ?? 'application/octet-stream'),
      uploaded: new Date(),
    });
    return { key } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      body: new Response(object.bytes).body!,
      httpMetadata: { contentType: object.contentType },
      httpEtag: '"fake"',
    } as R2ObjectBody;
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDeletes-- > 0) throw new Error('fake R2 delete failure');
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([a], [b]) => a.localeCompare(b));
    const start = options.cursor ? matching.findIndex(([key]) => key > options.cursor!) : 0;
    // Deliberately cap fake pages at two, so account deletion proves it keeps
    // relisting the now-shorter prefix until no objects remain.
    const limit = Math.min(options.limit ?? 1000, 2);
    const page = matching.slice(start, start + limit);
    const next = start + page.length;
    const base = {
      objects: page.map(([key, object]) => ({ key, uploaded: object.uploaded }) as R2Object),
      delimitedPrefixes: [],
    };
    if (next < matching.length) {
      return { ...base, truncated: true, cursor: page[page.length - 1]![0] };
    }
    return { ...base, truncated: false };
  }
}

export function useAuthWorkerTestEnv(createTestDb: () => TestDb): void {
  beforeEach(() => {
    db = createTestDb();
    photos = new FakePhotos();
    sentEmails = [];
    env = {
      DB: db.DB as Env['DB'],
      PHOTOS: photos as unknown as R2Bucket,
      EMAIL: {
        send: async (message: unknown) => {
          sentEmails.push(message);
        },
      } as unknown as SendEmail,
      CHAT: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as { token?: string; room?: string };
          const claims = await verifyDmTicket(
            'test-dm-ticket-secret',
            body.token ?? '',
            Date.now(),
          );
          if (!claims) return new Response('unauthorized', { status: 401 });
          const path = new URL(String(input)).pathname;
          if (path === '/api/groups/account-deletion')
            return Response.json({
              accountId: claims.sub,
              deletionId: claims.deletionId,
              tombstoned: true,
              rooms: [],
              nextCursor: null,
              coverage: 'registered-and-observed',
              legacyCoverage: 'unknown',
            });
          if (path === '/api/groups/account-deletion/room')
            return Response.json({ accountId: claims.sub, room: body.room, revoked: true });
          if (path === '/api/dm/revoke') return Response.json({ ok: true });
          return new Response('not found', { status: 404 });
        },
      } as unknown as Fetcher,
      MARKET: {
        fetch: async () => new Response(null, { status: 404 }),
      } as unknown as Fetcher,
      IP_PEPPER: 'test-pepper',
      DM_TICKET_SECRET: 'test-dm-ticket-secret',
      ALLOWED_ORIGINS: ORIGIN,
    };
  });
  afterEach(() => db.close());
}

export function req(path: string, init: RequestInit & { ip?: string; token?: string } = {}) {
  const { ip = '1.2.3.4', token, ...rest } = init;
  return new Request(`https://auth.0xnullai.com${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      'CF-Connecting-IP': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
}

/**
 * Query the database directly, to assert storage facts the API does not expose (the
 * token is not stored in the clear, orphan rows are gone).
 */
export function prepared(sql: string, ...args: unknown[]) {
  const stmt = env.DB.prepare(sql);
  return args.length ? stmt.bind(...args) : stmt;
}

export const post = (path: string, body: unknown, extra = {}) =>
  worker.fetch(req(path, { method: 'POST', body: JSON.stringify(body), ...extra }), env);

export const GOOD = {
  username: 'alice',
  email: 'alice@example.com',
  password: 'correct-horse-battery',
  acceptedTerms: LEGAL_TERMS_VERSION,
};

export async function registerUser(overrides: Record<string, unknown> = {}) {
  const res = await post('/api/auth/register', { ...GOOD, ...overrides });
  return {
    res,
    body: (await res.json()) as {
      user?: { id: string; role: 'user' | 'admin' };
      token?: string;
      error?: string;
    },
  };
}

export async function verifyRegisteredUser(body: {
  user?: { id: string };
  token?: string;
}): Promise<void> {
  await prepared(
    'UPDATE users SET email_verified_at = ? WHERE id = ?',
    Date.now(),
    body.user!.id,
  ).run();
}

export const get = (path: string, token?: string) => worker.fetch(req(path, { token }), env);
export const del = (path: string, token?: string) =>
  worker.fetch(req(path, { method: 'DELETE', token }), env);

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a user and a live session directly in the database.
 *
 * Registration runs a 210k-iteration PBKDF2 every time, and these cases need
 * two or three users each — going through the API would spend most of the
 * suite's runtime hashing passwords no assertion ever looks at. What is under
 * test here is the follow graph, and it only needs the rows to exist.
 */
export async function seedUser(username: string) {
  const id = `id-${username}`;
  const token = `token-${username}`;
  await prepared(
    'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    username,
    username,
    'unused',
    Date.now(),
  ).run();
  await prepared(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await sha256Hex(token),
    id,
    Date.now(),
    Date.now() + 86_400_000,
  ).run();
  return { id, username, token };
}

export const follow = (token: string, userId: string) =>
  post('/api/auth/follow', { userId }, { token });
export const block = (token: string, userId: string) =>
  post('/api/auth/block', { userId }, { token });

export async function listOf(path: string, token: string): Promise<string[]> {
  const res = await get(path, token);
  const body = (await res.json()) as { users: { username: string }[] };
  return body.users.map((u) => u.username);
}
