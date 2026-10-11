import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
import { handleCompanionLife } from './companion-life';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const person = {
  version: 0,
  kind: 'person',
  title: '小林',
  label: '朋友',
  content: '一起读书',
  occurredOn: null,
  personIds: [],
};
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, Date.now() + 60_000)
      .run();
    for (const relation of ['r1', 'r2'])
      await env.DB.prepare(
        'INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1,1)',
      )
        .bind(user, relation, relation, '', '', '', '')
        .run();
  }
});
afterEach(() => db.close());
async function call(
  id = '',
  method = 'GET',
  body?: unknown,
  account = 'alice',
  relation = 'r1',
  expectedAccount = account,
) {
  const response = await handleCompanionLife(
    new Request(
      `https://example.com/api/auth/companion-life${id ? `/${id}` : ''}?relationshipId=${relation}`,
      {
        method,
        headers: { authorization: `Bearer ${account}`, 'X-Account-Id': expectedAccount },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
    env,
    {},
  );
  if (!response) throw new Error('unmatched route');
  return response;
}
describe('private people, events and relationship lifecycle', () => {
  it('isolates accounts and relationships, validates links atomically and prevents stale overwrite', async () => {
    expect((await call('', 'GET', undefined, 'missing')).status).toBe(401);
    expect((await call('', 'GET', undefined, 'bob', 'r1', 'alice')).status).toBe(403);
    const created = await call('p', 'PUT', person);
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const event = {
      ...person,
      kind: 'event',
      title: '图书馆见面',
      personIds: ['p'],
      occurredOn: '2026-09-28',
    };
    expect((await call('event', 'PUT', event, 'bob')).status).toBe(409);
    expect((await call('event', 'PUT', event, 'alice', 'r2')).status).toBe(409);
    expect((await call('event', 'PUT', event)).status).toBe(201);
    expect((await call('p', 'PUT', { ...person, version: 1, title: '新名字' })).status).toBe(200);
    expect((await call('p', 'PUT', { ...person, version: 1, title: '旧写入' })).status).toBe(409);
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toEqual({ items: [] });
    expect((await call('p', 'PUT', { ...person, version: 2, kind: 'event' })).status).toBe(409);
  });
  it('deleting a person clears links with CAS; relationship deletion clears text and prevents resurrection', async () => {
    await call('p', 'PUT', person);
    await call('e', 'PUT', { ...person, kind: 'event', personIds: ['p'] });
    expect((await call('p', 'DELETE', { version: 1 })).status).toBe(200);
    const result = (await (await call()).json()) as {
      items: Array<{ id: string; personIds: string[]; version: number }>;
    };
    expect(result.items).toMatchObject([{ id: 'e', personIds: [], version: 2 }]);
    expect(
      (await call('e', 'PUT', { ...person, kind: 'event', version: 1, personIds: [] })).status,
    ).toBe(409);
    expect((await call('p', 'PUT', person)).status).toBe(409);
    await env.DB.prepare(
      'UPDATE character_relationships SET deleted_at=99 WHERE user_id=? AND id=?',
    )
      .bind('alice', 'r1')
      .run();
    expect((await call()).status).toBe(404);
    const rows = await env.DB.prepare(
      'SELECT title,content,person_ids,deleted_at FROM companion_life_records WHERE user_id=?',
    )
      .bind('alice')
      .all();
    expect(rows.results).toEqual(
      expect.arrayContaining([{ title: '', content: '', person_ids: '[]', deleted_at: 99 }]),
    );
  });
  it('validates dates and private schema; only one persistent lifecycle stage can exist', async () => {
    for (const extra of [
      { occurredOn: '2026-02-30' },
      { permissions: ['device'] },
      { personIds: ['x'] },
      { kind: 'unknown' },
      { content: 'x'.repeat(4001) },
    ])
      expect((await call('bad', 'PUT', { ...person, ...extra })).status).toBe(400);
    const stage = { ...person, kind: 'lifecycle', label: 'paused', title: '我们的关系' };
    expect((await call('life', 'PUT', stage)).status).toBe(201);
    expect((await call('life2', 'PUT', stage)).status).toBe(409);
    expect((await call('life', 'DELETE', { version: 1 })).status).toBe(409);
    expect(
      (await call('life', 'PUT', { ...stage, label: 'reconnecting', version: 1 })).status,
    ).toBe(200);
  });
});
