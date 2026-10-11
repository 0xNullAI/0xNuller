import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { expireMediumMemories } from './personal-memory';
import { sha256Hex } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: Env;
const base = '/api/auth/personal-memories';
const draft = { kind: 'person', title: '小林', content: '我的同事，周五面试。', version: 0 };

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB, ALLOWED_ORIGINS: 'https://0xnullai.com', IP_PEPPER: 'test' } as Env;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, 'unused', 1)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await sha256Hex(id), id, 1, Date.now() + 60_000)
      .run();
  }
});
afterEach(() => db.close());

function call(path = '', method = 'GET', body?: unknown, token = 'alice') {
  return worker.fetch(
    new Request(`https://0xnullai.com${base}${path}`, {
      method,
      headers: {
        Origin: 'https://0xnullai.com',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

describe('private personal memories', () => {
  it('refuses stale account headers before mutating memories', async () => {
    const response = await worker.fetch(
      new Request(`https://0xnullai.com${base}/friend`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer bob',
          'Content-Type': 'application/json',
          'X-Account-Id': 'alice',
        },
        body: JSON.stringify(draft),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({ items: [] });
  });

  it('requires an account and does not cache personal data', async () => {
    const response = await call('', 'GET', undefined, 'missing');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const saved = await call('/friend', 'PUT', draft);
    expect(saved.status).toBe(201);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(await (await call()).json()).toMatchObject({
      items: [{ id: 'friend', content: draft.content, version: 1 }],
    });
  });

  it('isolates accounts even when ids match and refuses ownership or sharing fields', async () => {
    await call('/friend', 'PUT', draft);
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({ items: [] });
    expect((await call('/friend', 'DELETE', { version: 1 }, 'bob')).status).toBe(409);
    expect((await call('/other', 'PUT', { ...draft, userId: 'alice' }, 'bob')).status).toBe(400);
    expect((await call('/other', 'PUT', { ...draft, scope: 'group' })).status).toBe(400);
    expect((await call('/friend', 'PUT', { ...draft, content: 'Bob的记忆' }, 'bob')).status).toBe(
      201,
    );
    expect(await (await call()).json()).toMatchObject({ items: [{ content: draft.content }] });
  });

  it('rejects stale edits, erases deleted content and prevents stale resurrection', async () => {
    await call('/friend', 'PUT', draft);
    expect(
      (await call('/friend', 'PUT', { ...draft, version: 1, content: '面试改到周六。' })).status,
    ).toBe(200);
    expect((await call('/friend', 'PUT', { ...draft, version: 1 })).status).toBe(409);
    expect((await call('/friend', 'DELETE', { version: 1 })).status).toBe(409);
    expect((await call('/friend', 'DELETE', { version: 2 })).status).toBe(200);
    expect((await call('/friend', 'PUT', draft)).status).toBe(409);
    expect((await call('/friend', 'PUT', { ...draft, version: 3 })).status).toBe(409);
    expect(await (await call()).json()).toMatchObject({ items: [] });
    expect(
      await env.DB.prepare(
        'SELECT title, content, version FROM personal_memories WHERE user_id = ? AND id = ?',
      )
        .bind('alice', 'friend')
        .first(),
    ).toEqual({ title: '', content: '', version: 3 });
  });

  it('expires medium-term text into a tombstone without deleting long-term memories', async () => {
    const now = Date.now();
    expect((await call('/recent', 'PUT', { ...draft, tier: 'medium' })).status).toBe(201);
    expect((await call('/lasting', 'PUT', draft)).status).toBe(201);
    expect((await call('/bob-recent', 'PUT', { ...draft, tier: 'medium' }, 'bob')).status).toBe(
      201,
    );
    await env.DB.prepare(
      "UPDATE personal_memories SET expires_at=? WHERE user_id='alice' AND id='recent'",
    )
      .bind(now - 1)
      .run();
    expect(await expireMediumMemories(env, now)).toBe(1);
    expect(await expireMediumMemories(env, now)).toBe(0);
    expect(await (await call()).json()).toMatchObject({ items: [{ id: 'lasting' }] });
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({
      items: [{ id: 'bob-recent', content: draft.content }],
    });
    expect(
      await env.DB.prepare(
        "SELECT title,content,version,deleted_at FROM personal_memories WHERE user_id='alice' AND id='recent'",
      ).first(),
    ).toEqual({ title: '', content: '', version: 2, deleted_at: now });
    expect((await call('/recent', 'PUT', { ...draft, tier: 'medium', version: 2 })).status).toBe(
      409,
    );
  });

  it('bounds input and active records, and cascades account deletion', async () => {
    expect((await call('/bad', 'PUT', { ...draft, content: 'x'.repeat(4001) })).status).toBe(400);
    expect((await call('/bad', 'PUT', { ...draft, content: 'x'.repeat(20_001) })).status).toBe(413);
    expect((await call('/bad', 'PUT', { ...draft, version: '0' })).status).toBe(400);
    for (let i = 0; i < 200; i++) {
      await env.DB.prepare(
        'INSERT INTO personal_memories (user_id,id,kind,title,content,version,created_at,updated_at) VALUES (?,?,?,?,?,1,1,1)',
      )
        .bind('alice', `m${i}`, 'note', 't', 'c')
        .run();
    }
    expect((await call('/overflow', 'PUT', draft)).status).toBe(409);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind('alice').run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM personal_memories').first()).toEqual(
      { count: 0 },
    );
  });
});
